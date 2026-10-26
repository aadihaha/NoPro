import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const apiKey = process.env.PINECONE_API_KEY;

if (!apiKey) {
    console.warn('⚠️ Warning: PINECONE_API_KEY is missing or empty in .env');
}

const pc = new Pinecone({
    apiKey: apiKey || 'dummy-key-to-prevent-crash'
});

// Export both names so any file can import either 'index' or 'pineconeIndex'
export const index = pc.index(process.env.PINECONE_INDEX_NAME || 'nopro-index');
export const pineconeIndex = index;