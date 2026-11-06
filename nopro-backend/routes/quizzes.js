const express = require('express');
const Groq = require('groq-sdk');
const { Pinecone } = require('@pinecone-database/pinecone');
const { PineconeStore } = require('@langchain/pinecone');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const { db } = require('../config/firebase');

const router = express.Router();

// ----------------------------------------------------------------------
// 1. Client Singletons (Pinecone, Google Gemini Embeddings, Groq)
// ----------------------------------------------------------------------
// NOTE FOR PINECONE SETUP:
// Google Generative AI's text-embedding-004 model generates 768-dimensional vectors.
// Your Pinecone index MUST be created with dimension: 768 (metric: cosine).
let pineconeClient = null;
let pineconeIndex = null;
let embeddingsInstance = null;
let groqClient = null;

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

function getGroqClient() {
  if (!groqClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GROQ_API_KEY environment variable.');
    }

    groqClient = new Groq({ apiKey });
  }
  return groqClient;
}

// ----------------------------------------------------------------------
// 2. Helper: Retrieve Context Chunks from Pinecone
// ----------------------------------------------------------------------
async function getRelevantContextChunks(topics, namespace) {
  try {
    const index = getPineconeIndex();
    const embeddings = getEmbeddings();

    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
      pineconeIndex: index,
      namespace,
      textKey: 'text',
    });

    const searchQuery = Array.isArray(topics) ? topics.join(', ') : String(topics);
    const searchResults = await vectorStore.similaritySearch(searchQuery, 5);

    return searchResults || [];
  } catch (error) {
    console.warn(`[Pinecone Quizzes Warning] Search failed for namespace "${namespace}":`, error.message);
    return [];
  }
}

// ----------------------------------------------------------------------
// 3. Helper: Robust JSON Parser for Quiz Questions
// ----------------------------------------------------------------------
function parseQuizResponse(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('Empty response received from Groq LLM.');
  }

  let cleaned = content.trim();

  // Strip Markdown code block fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (initialErr) {
    // Regex fallback to find the first JSON array in the output
    const match = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (nestedErr) {
        throw new Error(`Failed to parse extracted quiz JSON array: ${nestedErr.message}`);
      }
    } else {
      throw new Error(`Model response did not contain a valid JSON array: ${initialErr.message}`);
    }
  }

  // Handle case where LLM wrapped questions in an object
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    const arrayKey = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
    if (arrayKey) {
      parsed = parsed[arrayKey];
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Parsed quiz response is not an array.');
  }

  // Validate and normalize schema for each question
  return parsed.map((item, index) => {
    const questionText = String(item.question || `Diagnostic Question ${index + 1}`).trim();
    const rawOptions = Array.isArray(item.options) ? item.options.map(String) : [];
    
    // Ensure exactly 4 options
    let options = rawOptions.slice(0, 4);
    while (options.length < 4) {
      options.push(`Option ${options.length + 1}`);
    }

    let correctAnswer = String(item.correct_answer || options[0]).trim();
    // Verify correct_answer matches one of the options
    if (!options.includes(correctAnswer)) {
      // If it looks like a letter index (e.g. "A", "B", "C", "D")
      const letterIndex = { A: 0, B: 1, C: 2, D: 3 }[correctAnswer.toUpperCase()];
      if (letterIndex !== undefined && options[letterIndex]) {
        correctAnswer = options[letterIndex];
      } else {
        correctAnswer = options[0];
      }
    }

    const explanation = String(
      item.explanation || 'Refer to the relevant study material chunk for conceptual details.'
    ).trim();

    return {
      question: questionText,
      options,
      correct_answer: correctAnswer,
      explanation,
    };
  });
}

// ----------------------------------------------------------------------
// 4. POST /generate - Generate 5-Question Weekly Diagnostic Quiz
// ----------------------------------------------------------------------
router.post('/generate', async (req, res) => {
  try {
    const { userId, topics } = req.body;
    const isGlobal = req.body.isGlobal === true || req.body.isGlobal === 'true' || req.body.isGlobal === '1';

    // 4.1 Validate request fields
    if (!isGlobal && (!userId || typeof userId !== 'string' || !userId.trim())) {
      return res.status(400).json({
        success: false,
        error: '"userId" is required when "isGlobal" is false.',
      });
    }

    if (!topics || (!Array.isArray(topics) && typeof topics !== 'string')) {
      return res.status(400).json({
        success: false,
        error: '"topics" must be an array of strings or a comma-separated string.',
      });
    }

    const topicsList = Array.isArray(topics)
      ? topics.map((t) => String(t).trim()).filter(Boolean)
      : String(topics)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);

    if (topicsList.length === 0) {
      return res.status(400).json({
        success: false,
        error: '"topics" must contain at least one valid topic name.',
      });
    }

    if (!db) {
      return res.status(500).json({
        success: false,
        error: 'Firestore database is not initialized. Please verify Firebase credentials.',
      });
    }

    // 4.2 Determine Pinecone namespace
    const namespace = isGlobal ? 'global' : `user_${userId.trim()}`;

    // 4.3 Query Pinecone for top 5 context chunks
    const contextDocs = await getRelevantContextChunks(topicsList, namespace);

    const formattedContext =
      contextDocs.length > 0
        ? contextDocs
            .map(
              (doc, idx) =>
                `[Reference Chunk ${idx + 1} | Book: ${doc.metadata?.bookName || 'Document'}]:\n${doc.pageContent}`
            )
            .join('\n\n---\n\n')
        : 'Note: No specific document chunks found in this namespace. Formulate rigorous diagnostic questions on the fundamental syllabus principles of the specified topics.';

    // 4.4 Build Strict System Prompt and User Prompt
    const systemPrompt = `You are an elite academic examiner and diagnostic quiz architect for the NoPro study coach app.
Your task is to generate a rigorous, 5-question Multiple Choice Quiz based strictly on the provided course material chunks for the requested topics.

STRICT INSTRUCTIONS:
1. Output ONLY a valid raw JSON array containing exactly 5 question objects.
2. Absolutely NO markdown backticks (no \`\`\` or \`\`\`json), NO explanatory text, NO greetings, and NO trailing notes.
3. Every question object MUST have strictly these 4 keys:
   - "question": (string) Clear, unambiguous diagnostic question testing understanding of the topic.
   - "options": (array of exactly 4 strings) Four distinct plausible answer choices.
   - "correct_answer": (string) Must be the verbatim string of the correct choice found inside the "options" array.
   - "explanation": (string) Concise academic explanation proving why the answer is correct according to the reference material.
4. Base all questions strictly on the provided context chunks. Test deep comprehension rather than trivial recall.`;

    const userPrompt = `Target Diagnostic Topics: ${topicsList.join(', ')}

Reference Study Material Context:
${formattedContext}

Generate the 5-question multiple choice diagnostic quiz as a raw JSON array matching the schema.`;

    // 4.5 Call Groq LLM (llama3-70b-8192)
    const groq = getGroqClient();

    const completion = await groq.chat.completions.create({
      model: 'llama3-70b-8192',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2, // Low temperature for high factual precision
      max_tokens: 3000,
    });

    const rawContent = completion.choices?.[0]?.message?.content;

    // 4.6 Parse and validate JSON questions
    const questions = parseQuizResponse(rawContent);

    // 4.7 Save quiz document to Firestore "Quizzes" collection
    const quizPayload = {
      userId: isGlobal ? 'global' : userId.trim(),
      topics: topicsList,
      isGlobal,
      namespace,
      questions,
      total_questions: questions.length,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const quizRef = await db.collection('Quizzes').add(quizPayload);

    // 4.8 Return 200 JSON response
    return res.status(200).json({
      success: true,
      message: 'Weekly diagnostic quiz generated and saved successfully.',
      quizId: quizRef.id,
      questions,
      data: {
        quizId: quizRef.id,
        userId: quizPayload.userId,
        topics: topicsList,
        status: 'pending',
        questions,
      },
    });
  } catch (error) {
    console.error('Error generating diagnostic quiz:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to generate diagnostic quiz.',
      details: error.message,
    });
  }
});

module.exports = router;
