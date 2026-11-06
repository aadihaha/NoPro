const express = require('express');
const multer = require('multer');
const { Pinecone } = require('@pinecone-database/pinecone');
const { PineconeStore } = require('@langchain/pinecone');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const { Document } = require('@langchain/core/documents');

const router = express.Router();

// ----------------------------------------------------------------------
// 1. Multer Configuration (Memory Storage)
// ----------------------------------------------------------------------
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB max limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF documents are supported.'));
    }
  },
});

// ----------------------------------------------------------------------
// 2. Resilient Text Splitter Resolution
// ----------------------------------------------------------------------
let RecursiveCharacterTextSplitter;
try {
  ({ RecursiveCharacterTextSplitter } = require('@langchain/textsplitters'));
} catch {
  try {
    ({ RecursiveCharacterTextSplitter } = require('langchain/text_splitter'));
  } catch {
    // Built-in recursive splitter fallback matching LangChain's chunking algorithm
    RecursiveCharacterTextSplitter = class FallbackRecursiveTextSplitter {
      constructor({ chunkSize = 1000, chunkOverlap = 200, separators = ['\n\n', '\n', ' ', ''] } = {}) {
        this.chunkSize = chunkSize;
        this.chunkOverlap = chunkOverlap;
        this.separators = separators;
      }

      async splitText(text) {
        if (!text) return [];
        return this._splitText(text, this.separators);
      }

      _splitText(text, separators) {
        const finalChunks = [];
        let separator = separators[separators.length - 1];
        let newSeparators = [];
        for (let i = 0; i < separators.length; i++) {
          const s = separators[i];
          if (s === '') {
            separator = s;
            break;
          }
          if (text.includes(s)) {
            separator = s;
            newSeparators = separators.slice(i + 1);
            break;
          }
        }

        const splits = separator ? text.split(separator) : Array.from(text);
        let goodSplits = [];
        for (const s of splits) {
          if (s.length < this.chunkSize) {
            goodSplits.push(s);
          } else {
            if (goodSplits.length) {
              finalChunks.push(...this._mergeSplits(goodSplits, separator));
              goodSplits = [];
            }
            if (newSeparators.length === 0) {
              finalChunks.push(s);
            } else {
              finalChunks.push(...this._splitText(s, newSeparators));
            }
          }
        }
        if (goodSplits.length) {
          finalChunks.push(...this._mergeSplits(goodSplits, separator));
        }
        return finalChunks;
      }

      _mergeSplits(splits, separator) {
        const docs = [];
        let currentDoc = [];
        let total = 0;
        for (const d of splits) {
          const len = d.length;
          if (total + len + (currentDoc.length > 0 ? separator.length : 0) > this.chunkSize) {
            if (currentDoc.length > 0) {
              const doc = currentDoc.join(separator);
              if (doc.trim().length > 0) docs.push(doc);
              while (total > this.chunkOverlap || (total + len + (currentDoc.length > 0 ? separator.length : 0) > this.chunkSize && total > 0)) {
                total -= currentDoc[0].length + (currentDoc.length > 1 ? separator.length : 0);
                currentDoc.shift();
              }
            }
          }
          currentDoc.push(d);
          total += len + (currentDoc.length > 1 ? separator.length : 0);
        }
        if (currentDoc.length > 0) {
          const doc = currentDoc.join(separator);
          if (doc.trim().length > 0) docs.push(doc);
        }
        return docs;
      }

      async createDocuments(texts, metadatas = []) {
        const docs = [];
        for (let i = 0; i < texts.length; i++) {
          const text = texts[i];
          const meta = metadatas[i] || {};
          const chunks = await this.splitText(text);
          for (const chunk of chunks) {
            docs.push(new Document({ pageContent: chunk, metadata: { ...meta } }));
          }
        }
        return docs;
      }
    };
  }
}

// ----------------------------------------------------------------------
// 3. Helper: PDF Text Extraction (Supports pdf-parse v1 & v2)
// ----------------------------------------------------------------------
async function extractTextFromPDF(buffer) {
  const pdfParseModule = require('pdf-parse');

  // pdf-parse v2+ (Class-based)
  if (pdfParseModule.PDFParse) {
    const parser = new pdfParseModule.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      if (typeof parser.destroy === 'function') {
        await parser.destroy();
      }
    }
  }

  // pdf-parse v1 (Function-based)
  if (typeof pdfParseModule === 'function') {
    const result = await pdfParseModule(buffer);
    return result.text || '';
  }

  // Default export wrapper
  if (typeof pdfParseModule.default === 'function') {
    const result = await pdfParseModule.default(buffer);
    return result.text || '';
  }

  throw new Error('Unsupported pdf-parse export module format.');
}

// ----------------------------------------------------------------------
// 4. Pinecone & Google Gemini Embeddings Client Singletons
// ----------------------------------------------------------------------
// NOTE FOR PINECONE SETUP:
// Google Generative AI's text-embedding-004 model generates 768-dimensional vectors.
// Your Pinecone index MUST be created with dimension: 768 (metric: cosine).
// OpenAI previously used 1536 dimensions; inserting 768-dim vectors into a 1536-dim
// index will result in a dimensional mismatch error.
let pineconeClient = null;
let pineconeIndex = null;
let embeddingsInstance = null;

function getPineconeIndex() {
  if (!pineconeIndex) {
    const apiKey = process.env.PINECONE_API_KEY;
    const indexName = process.env.PINECONE_INDEX_NAME || process.env.PINECONE_INDEX;

    if (!apiKey) {
      throw new Error('Missing PINECONE_API_KEY environment variable.');
    }
    if (!indexName) {
      throw new Error('Missing PINECONE_INDEX_NAME environment variable.');
    }

    pineconeClient = new Pinecone({ apiKey });
    pineconeIndex = pineconeClient.Index(indexName);
  }
  return pineconeIndex;
}

function getEmbeddings() {
  if (!embeddingsInstance) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable.');
    }

    embeddingsInstance = new GoogleGenerativeAIEmbeddings({
      apiKey,
      model: 'text-embedding-004',
    });
  }
  return embeddingsInstance;
}

// ----------------------------------------------------------------------
// 5. POST /upload - RAG Document Upload Pipeline
// ----------------------------------------------------------------------
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    // 5.1 Validate uploaded file
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        error: 'No PDF file uploaded. Please upload a file with the form field name "file".',
      });
    }

    // 5.2 Validate and sanitize request body fields
    const { bookName, userId } = req.body;
    const isGlobal = req.body.isGlobal === true || req.body.isGlobal === 'true' || req.body.isGlobal === '1';

    if (!bookName || typeof bookName !== 'string' || !bookName.trim()) {
      return res.status(400).json({
        success: false,
        error: '"bookName" is required and must be a non-empty string.',
      });
    }

    if (!isGlobal && (!userId || typeof userId !== 'string' || !userId.trim())) {
      return res.status(400).json({
        success: false,
        error: '"userId" is required when "isGlobal" is false.',
      });
    }

    // 5.3 Determine Pinecone namespace
    const namespace = isGlobal ? 'global' : `user_${userId.trim()}`;

    // 5.4 Extract text from PDF buffer
    let rawText = '';
    try {
      rawText = await extractTextFromPDF(req.file.buffer);
    } catch (parseErr) {
      return res.status(400).json({
        success: false,
        error: `Failed to parse PDF document: ${parseErr.message}`,
      });
    }

    const trimmedText = rawText.trim();
    if (!trimmedText) {
      return res.status(422).json({
        success: false,
        error: 'No readable text could be extracted from the uploaded PDF. Scanned image-only PDFs require OCR.',
      });
    }

    // 5.5 Chunk the text (1000 size, 200 overlap)
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    const chunks = await textSplitter.splitText(trimmedText);
    if (!chunks || chunks.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'Document text could not be chunked.',
      });
    }

    // 5.6 Create LangChain Document objects with rich metadata
    const documents = chunks.map((chunk, index) => {
      return new Document({
        pageContent: chunk,
        metadata: {
          bookName: bookName.trim(),
          userId: isGlobal ? 'global' : userId.trim(),
          isGlobal,
          chunkIndex: index,
          totalChunks: chunks.length,
          originalFileName: req.file.originalname,
          fileSizeBytes: req.file.size,
          uploadedAt: new Date().toISOString(),
        },
      });
    });

    // 5.7 Upsert vectors into Pinecone
    const index = getPineconeIndex();
    const embeddings = getEmbeddings();

    await PineconeStore.fromDocuments(documents, embeddings, {
      pineconeIndex: index,
      namespace,
      textKey: 'text',
    });

    // 5.8 Return 200 JSON success response with chunk count
    return res.status(200).json({
      success: true,
      message: 'Document successfully processed and indexed into Pinecone.',
      bookName: bookName.trim(),
      namespace,
      chunkCount: documents.length,
      isGlobal,
      userId: isGlobal ? null : userId.trim(),
    });
  } catch (error) {
    console.error('Error in RAG document upload pipeline:', error);
    return res.status(500).json({
      success: false,
      error: 'An error occurred while processing and vectorizing the document.',
      details: error.message,
    });
  }
});

module.exports = router;
