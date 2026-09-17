require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// CORS is wide open here for local dev convenience. If you deploy this
// somewhere other people can reach, lock this down to your frontend's
// actual origin before you do — otherwise anyone can call your endpoints
// and spend your API credits.
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

if (!ANTHROPIC_API_KEY) {
  console.warn('\n⚠️  ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key from the Claude Console before uploading anything.\n');
}

async function callClaude(messages, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens || 1024,
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Anthropic API error (' + res.status + '): ' + text);
  }
  return res.json();
}

function textFrom(data) {
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parseJsonReply(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return a JSON object.');
  return JSON.parse(match[0]);
}

const EXTRACTION_INSTRUCTIONS =
  'You are reviewing a document for a legal case-intake system. Extract the following as JSON only, ' +
  'matching exactly this shape:\n' +
  '{"docType": string (short label like "Police report", "Contract", "Medical record", "Correspondence", ' +
  '"Court filing", "Invoice", "Photo evidence", "Other"),\n' +
  '"title": string (a short descriptive title, e.g. "Incident report — J. Alvarez"),\n' +
  '"date": string (the date on the document if present, else "undated"),\n' +
  '"parties": string[] (names of people or entities mentioned),\n' +
  '"summary": string (2-3 plain-English sentences on what this document says),\n' +
  '"keyFacts": string[] (3-6 short bullet facts a lawyer would need to know),\n' +
  '"flags": string[] (anything urgent, inconsistent, illegible, or that needs the attorney\'s personal ' +
  'attention — empty array if nothing stands out)}\n' +
  'Reply with only the JSON object, nothing else.';

// Image or PDF upload -> structured extraction
app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const mediaType = req.file.mimetype;
    const base64 = req.file.buffer.toString('base64');

    let block;
    if (mediaType === 'application/pdf') {
      block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
    } else if (mediaType.startsWith('image/')) {
      block = { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
    } else {
      return res.status(400).json({ error: 'Unsupported file type: ' + mediaType + ' (use an image or a PDF).' });
    }

    const messages = [{ role: 'user', content: [block, { type: 'text', text: EXTRACTION_INSTRUCTIONS }] }];
    const data = await callClaude(messages, 1024);
    const extracted = parseJsonReply(textFrom(data));
    res.json(extracted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Pasted text -> structured extraction (no file needed)
app.post('/api/extract-text', async (req, res) => {
  try {
    const text = (req.body && req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'No text provided.' });

    const prompt = EXTRACTION_INSTRUCTIONS + '\n\nDocument text:\n' + text;
    const messages = [{ role: 'user', content: prompt }];
    const data = await callClaude(messages, 1024);
    const extracted = parseJsonReply(textFrom(data));
    res.json(extracted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// All extracted documents so far -> a synthesized case brief
app.post('/api/brief', async (req, res) => {
  try {
    const { caseName, documents } = req.body || {};
    if (!documents || !documents.length) return res.status(400).json({ error: 'No documents provided.' });

    const docsText = documents
      .map((x, i) => {
        return (
          '[Doc ' + (i + 1) + '] ' + (x.docType || 'Document') + ' — ' + (x.title || '') + ' (' + (x.date || 'undated') + ')\n' +
          'Parties: ' + (x.parties || []).join(', ') + '\n' +
          'Summary: ' + (x.summary || '') + '\n' +
          'Key facts: ' + (x.keyFacts || []).join('; ') + '\n' +
          'Flags: ' + ((x.flags || []).join('; ') || 'none')
        );
      })
      .join('\n\n');

    const prompt =
      'You are a legal assistant preparing a running case brief for "' + (caseName || 'this matter') +
      '" so the attorney does not have to read every source document individually before a meeting. ' +
      'Below are structured extractions from every document uploaded to this case so far. Write a concise ' +
      'brief with these sections, using "###" as a heading marker before each section title:\n' +
      '### Overview — one short paragraph on where the matter stands.\n' +
      '### Parties — who is involved and their role, as a short list.\n' +
      '### Timeline — key dated events in chronological order, as a short list.\n' +
      '### Needs your attention — anything urgent, inconsistent, or unclear across the documents, as a short ' +
      'list. Say "Nothing flagged yet" if there is nothing.\n' +
      'Keep it tight and skimmable. Do not restate the raw extractions verbatim — synthesize.\n\n' + docsText;

    const data = await callClaude([{ role: 'user', content: prompt }], 1500);
    res.json({ text: textFrom(data) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Loom AI backend running at http://localhost:' + PORT));
