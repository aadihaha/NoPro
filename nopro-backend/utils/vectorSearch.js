// utils/vectorSearch.js
import { GoogleGenAI } from '@google/genai';
import { index } from '../config/pinecone.js';
import dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Searches Pinecone index for relevant text chunks based on topic.
 * @param {string} topic - The topic or query string.
 * @param {string} userId - The user ID for namespace routing / personal books.
 * @param {boolean} isGlobal - Flag indicating global syllabus books vs user-uploaded files.
 * @returns {Promise<Array>} Top relevant text chunks with metadata.
 */
export async function queryRelevantChunks(topic, userId, isGlobal = true) {
  try {
    // 1. Generate 768-dimensional embedding using Google Gemini text-embedding-004
    const response = await ai.models.embedContent({
      model: 'text-embedding-004',
      contents: topic,
    });
    
    const queryVector = response.embedding.values;

    // 2. Select correct namespace ('global' or user-specific)
    const namespace = isGlobal ? "global" : `user_${userId}`;

    // 3. Define metadata filter
    const filter = isGlobal 
      ? { isGlobal: { $eq: true } } 
      : { user_id: { $eq: userId } };

    // 4. Query Pinecone
    const queryResponse = await index.namespace(namespace).query({
      vector: queryVector,
      topK: 5,
      includeMetadata: true,
      filter: filter,
    });

    // 5. Return clean results
    return queryResponse.matches.map(match => ({
      score: match.score,
      chunk_id: match.metadata.chunk_id,
      book_name: match.metadata.book_name,
      page_number: match.metadata.page_number,
      topic_name: match.metadata.topic_name,
      text: match.metadata.text || match.metadata.chunk_text
    }));
  } catch (error) {
    console.error("Error querying Pinecone chunks:", error);
    throw new Error("Vector search failed");
  }
}