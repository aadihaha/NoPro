const express = require('express');
const Groq = require('groq-sdk');
const { Pinecone } = require('@pinecone-database/pinecone');
const { PineconeStore } = require('@langchain/pinecone');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');

const router = express.Router();

// ----------------------------------------------------------------------
// 1. Client Singletons (Pinecone, Google Gemini Embeddings, Groq)
// ----------------------------------------------------------------------
// NOTE FOR PINECONE SETUP:
// Google Generative AI's text-embedding-004 model generates 768-dimensional vectors.
// Your Pinecone index MUST be created with dimension: 768 (metric: cosine).
// OpenAI previously used 1536 dimensions; querying with mismatched dimensions will fail.
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
// 2. Helper: Retrieve Relevant Pinecone Chunks
// ----------------------------------------------------------------------
async function getRelevantContextChunks(subjects, namespace) {
  try {
    const index = getPineconeIndex();
    const embeddings = getEmbeddings();

    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
      pineconeIndex: index,
      namespace,
      textKey: 'text',
    });

    const searchQuery = Array.isArray(subjects) ? subjects.join(', ') : String(subjects);
    const searchResults = await vectorStore.similaritySearch(searchQuery, 5);

    return searchResults || [];
  } catch (error) {
    console.warn(`[Pinecone Warning] Similarity search failed for namespace "${namespace}": ${error.message}`);
    // Return empty array to allow graceful degradation if no docs are uploaded yet
    return [];
  }
}

// ----------------------------------------------------------------------
// 3. Helper: Robust JSON Parser for LLM Response
// ----------------------------------------------------------------------
function parseLLMResponse(content) {
  if (!content || typeof content !== 'string') {
    throw new Error('Empty response received from Groq LLM.');
  }

  let cleaned = content.trim();

  // Strip Markdown code block wrapping if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (initialErr) {
    // Fallback: extract the first valid JSON array using regex
    const match = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (nestedErr) {
        throw new Error(`Failed to parse extracted JSON array: ${nestedErr.message}`);
      }
    } else {
      throw new Error(`Model response did not contain a valid JSON array: ${initialErr.message}`);
    }
  }

  // Handle case where LLM wrapped array in an object: { "roadmap": [...] } or { "sessions": [...] }
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    const arrayKey = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
    if (arrayKey) {
      parsed = parsed[arrayKey];
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error('LLM output format invalid: Expected a JSON array of study sessions.');
  }

  // Validate and normalize schema for each session
  return parsed.map((item, index) => ({
    day: Number(item.day) || index + 1,
    subject: String(item.subject || 'General Study'),
    topic: String(item.topic || 'Review & Core Concepts'),
    duration_minutes: Number(item.duration_minutes) || 45,
    break_minutes: Number(item.break_minutes) || 15,
  }));
}

// ----------------------------------------------------------------------
// 4. POST /generate - AI Flexible Roadmap Generator
// ----------------------------------------------------------------------
router.post('/generate', async (req, res) => {
  try {
    const { userId, examDate, availableHoursPerDay, subjects } = req.body;
    const isGlobal = req.body.isGlobal === true || req.body.isGlobal === 'true' || req.body.isGlobal === '1';

    // 4.1 Validate request body fields
    if (!isGlobal && (!userId || typeof userId !== 'string' || !userId.trim())) {
      return res.status(400).json({
        success: false,
        error: '"userId" is required when "isGlobal" is false.',
      });
    }

    if (!examDate || typeof examDate !== 'string' || !examDate.trim()) {
      return res.status(400).json({
        success: false,
        error: '"examDate" is required (e.g. "2026-12-15").',
      });
    }

    const hours = Number(availableHoursPerDay);
    if (isNaN(hours) || hours <= 0 || hours > 24) {
      return res.status(400).json({
        success: false,
        error: '"availableHoursPerDay" must be a positive number between 0.5 and 24.',
      });
    }

    if (!subjects || (!Array.isArray(subjects) && typeof subjects !== 'string')) {
      return res.status(400).json({
        success: false,
        error: '"subjects" must be an array of strings or a comma-separated string.',
      });
    }

    const subjectsList = Array.isArray(subjects)
      ? subjects.map((s) => String(s).trim()).filter(Boolean)
      : String(subjects)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

    if (subjectsList.length === 0) {
      return res.status(400).json({
        success: false,
        error: '"subjects" must contain at least one valid subject name.',
      });
    }

    // 4.2 Determine Pinecone namespace
    const namespace = isGlobal ? 'global' : `user_${userId.trim()}`;

    // 4.3 Query Pinecone for top 5 context chunks
    const contextDocs = await getRelevantContextChunks(subjectsList, namespace);

    const formattedContext =
      contextDocs.length > 0
        ? contextDocs
            .map(
              (doc, idx) =>
                `[Chunk ${idx + 1} | Book: ${doc.metadata?.bookName || 'Document'}]:\n${doc.pageContent}`
            )
            .join('\n\n---\n\n')
        : 'No specific document chunks found in this namespace. Generate syllabus-standard topics for the requested subjects.';

    // 4.4 Construct strict Prompts
    const systemPrompt = `You are an expert academic planner and elite study coach for the NoPro app.
Your objective is to generate an optimal, realistic, and highly motivating daily study roadmap leading up to the student's exam date.

STRICT INSTRUCTIONS:
1. Output ONLY a raw, valid JSON array of daily study session objects.
2. Absolutely NO markdown backticks (no \`\`\` or \`\`\`json), NO explanatory text, NO greetings, and NO trailing notes.
3. Every element in the array MUST strictly conform to this schema:
   - "day": integer (Day number in sequence: 1, 2, 3...)
   - "subject": string (One of the requested subjects)
   - "topic": string (Specific topic or chapter; strongly ground this in the provided reference context chunks whenever available)
   - "duration_minutes": integer (Study session duration in minutes, appropriate for the daily study allowance)
   - "break_minutes": integer (Rest interval in minutes, e.g. 10 to 20 minutes)
4. Distribute the study sessions evenly across the days leading up to the exam date. Total study time per day must strictly adhere to the student's available daily hours.
5. Prioritize core conceptual understanding early, followed by practice and final review sessions near the exam date.`;

    const userPrompt = `Student Study Profile:
- Target Exam Date: ${examDate}
- Daily Available Study Time: ${hours} hours/day
- Subjects to Cover: ${subjectsList.join(', ')}

Reference Study Chunks (from uploaded documents):
${formattedContext}

Generate the complete study roadmap as a raw JSON array matching the required schema.`;

    // 4.5 Initialize Groq and call llama3-70b-8192
    const groq = getGroqClient();

    const completion = await groq.chat.completions.create({
      model: 'llama3-70b-8192',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });

    const rawContent = completion.choices?.[0]?.message?.content;

    // 4.6 Parse and validate JSON output
    const roadmapSessions = parseLLMResponse(rawContent);

    // 4.7 Return 200 JSON success response
    return res.status(200).json({
      success: true,
      data: {
        roadmap: roadmapSessions,
        totalSessions: roadmapSessions.length,
        contextChunksRetrieved: contextDocs.length,
        namespace,
        examDate,
        availableHoursPerDay: hours,
        subjects: subjectsList,
      },
    });
  } catch (error) {
    console.error('Error generating AI study roadmap:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to generate study roadmap.',
      details: error.message,
    });
  }
});

module.exports = router;
