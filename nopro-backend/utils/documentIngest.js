// utils/documentIngest.js
import { GoogleGenAI } from '@google/genai';
import { index } from '../config/pinecone.js';
import dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Ingests a text document/book chapter into Pinecone.
 * @param {Object} params
 * @param {string} params.bookName - Name of the book/syllabus document.
 * @param {string} params.topicName - Topic or chapter name.
 * @param {string} params.text - Full text content to be chunked and embedded.
 * @param {string} params.userId - Owner user ID (or 'global' for global syllabus books).
 * @param {boolean} params.isGlobal - True if it's a platform-wide book, false for user uploads.
 */
export async function ingestDocument({ bookName, topicName, text, userId = 'global', isGlobal = true }) {
  try {
    // 1. Simple text chunking (e.g., splitting by paragraphs or fixed length, ~500 chars per chunk)
    const rawChunks = text.split(/\n\n+/).filter(chunk => chunk.trim().length > 0);
    
    if (rawChunks.length === 0) {
      throw new Error("No valid text content found for ingestion.");
    }

    const vectorsToUpsert = [];

    // 2. Process each chunk
    for (let i = 0; i < rawChunks.length; i++) {
      const chunkText = rawChunks[i].trim();
      const chunkId = `${bookName.replace(/\s+/g, '_')}_topic_${topicName.replace(/\s+/g, '_')}_chunk_${i + 1}`;

      // Generate embedding using Gemini text-embedding-004
      const response = await ai.models.embedContent({
        model: 'text-embedding-004',
        contents: chunkText,
      });

      const values = response.embedding.values;

      // Prepare vector object with matching metadata schema
      vectorsToUpsert.push({
        id: chunkId,
        values: values,
        metadata: {
          chunk_id: chunkId,
          book_name: bookName,
          topic_name: topicName,
          page_number: 1, // Can be dynamic if parsed from real PDF
          text: chunkText,
          user_id: userId,
          isGlobal: isGlobal
        }
      });
    }

    // 3. Select namespace
    const namespace = isGlobal ? "global" : `user_${userId}`;

    // 4. Batch upsert into Pinecone
    await index.namespace(namespace).upsert(vectorsToUpsert);

    console.log(`Successfully ingested ${vectorsToUpsert.length} chunks for book: "${bookName}" into namespace: "${namespace}"`);
    return { success: true, chunksCount: vectorsToUpsert.length };

  } catch (error) {
    console.error("Error during document ingestion:", error);
    throw new Error("Document ingestion failed");
  }
}