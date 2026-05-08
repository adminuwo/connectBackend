const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const WordExtractor = require("word-extractor");
const extractor = new WordExtractor();
const XLSX = require('xlsx');
const { GoogleGenAI, Modality } = require('@google/genai');
const gcs = require('./gcs'); // Import GCS for image hosting

class SimpleRAG {
    constructor(openai) {
        this.openai = openai;
        this.clientChunks = {}; // Store { clientId: [{ text: string, embedding: number[] }] }
        this.baseKbPath = path.join(__dirname, 'knowledge_base');
        this.embeddingCache = new Map(); // Simple cache for query embeddings
    }

    // Initialize and load knowledge base for all clients
    async init() {
        if (!fs.existsSync(this.baseKbPath)) {
            fs.mkdirSync(this.baseKbPath);
        }

        const clientFolders = fs.readdirSync(this.baseKbPath).filter(f => fs.lstatSync(path.join(this.baseKbPath, f)).isDirectory());
        
        for (const folderName of clientFolders) {
            // Standardize: Extract ID from Name_ID or use folder as ID if no underscore
            const parts = folderName.split('_');
            const clientId = parts[parts.length - 1];
            
            // Avoid duplicate loading if we have both 'ID' and 'Name_ID' folders
            if (folderName === clientId && clientFolders.some(f => f.endsWith(`_${clientId}`) && f !== clientId)) {
                console.log(`[RAG] 🧹 Skipping redundant ID-only folder: ${folderName}`);
                continue;
            }

            console.log(`[RAG] 📁 Loading knowledge from: ${folderName} (ID: ${clientId})`);
            await this.loadClientKnowledge(folderName, clientId);
        }
        
        console.log(`[RAG] ✅ Initialization complete. Active clients: ${Object.keys(this.clientChunks).length}`);
    }

    async extractTextFromFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        try {
            if (ext === '.pdf') {
                const dataBuffer = fs.readFileSync(filePath);
                const data = await pdf(dataBuffer);
                return data.text;
            } else if (ext === '.docx' || ext === '.doc') {
                const doc = await extractor.extract(filePath);
                return doc.getBody();
            } else if (ext === '.txt') {
                return fs.readFileSync(filePath, 'utf8');
            } else if (ext === '.xlsx' || ext === '.xls') {
                const workbook = XLSX.readFile(filePath);
                let fullText = "";
                workbook.SheetNames.forEach(sheetName => {
                    const sheet = workbook.Sheets[sheetName];
                    fullText += `--- Sheet: ${sheetName} ---\n`;
                    fullText += XLSX.utils.sheet_to_txt(sheet) + "\n";
                });
                return fullText;
            }
        } catch (error) {
            console.error(`[RAG] Error extracting text from ${filePath}:`, error.message);
        }
        return '';
    }

    async loadClientKnowledge(folderName, clientId) {
        const clientPath = path.join(this.baseKbPath, folderName);
        if (!fs.existsSync(clientPath)) {
            fs.mkdirSync(clientPath, { recursive: true });
        }

        const supportedExts = ['.txt', '.docx', '.pdf', '.doc', '.xlsx', '.xls'];
        const files = fs.readdirSync(clientPath).filter(f => supportedExts.includes(path.extname(f).toLowerCase()));
        this.clientChunks[clientId] = [];

        console.log(`[RAG] 📂 Client ${clientId}: Found ${files.length} supported files.`);

        for (const file of files) {
            console.log(`[RAG] 📄 Processing: ${file}...`);
            let content = await this.extractTextFromFile(path.join(clientPath, file));
            if (!content || content.trim().length === 0) continue;

            // Normalize content to improve matching (handle case and extra spaces)
            // We keep the original for display but normalize for embedding if needed,
            // but actually OpenAI embeddings handle case well. 
            // The issue is likely 'AI MALL' vs 'AIMALL'. 
            // Let's ensure common tokens are recognizable.
            
            const rawChunks = this.chunkText(content, 800);
            console.log(`[RAG] ✂️ Split ${file} into ${rawChunks.length} chunks.`);

            for (let i = 0; i < rawChunks.length; i++) {
                let chunk = rawChunks[i].trim();
                if (!chunk) continue;
                
                // Clean file name for metadata (remove numeric prefixes/IDs)
                const cleanFileName = file.replace(/^\d+[\s_-]*/, '').replace(/\.[^/.]+$/, "").replace(/_/g, " ").replace(/-/g, " ");
                
                // Add Source Metadata to the chunk text
                const chunkWithMeta = `[Source Document: ${cleanFileName}]\n${chunk}`;

                try {
                    process.stdout.write(`[RAG] 🧠 Embedding ${file} (Part ${i+1}/${rawChunks.length})... \r`);
                    
                    // We generate embedding for the chunk. 
                    // To handle "AIMALL" vs "AI MALL", we could normalize the text inside the embedding input,
                    // but OpenAI embeddings are usually good at this.
                    // The best way is to ensure the query is also normalized similarly.
                    const embedding = await this.getEmbedding(chunkWithMeta);
                    
                    this.clientChunks[clientId].push({ 
                        text: chunkWithMeta, 
                        embedding,
                        source: file
                    });
                } catch (err) {
                    console.error(`\n[RAG] ❌ Embedding Error for ${file}:`, err.message);
                }
            }
        }
        console.log(`\n[RAG] ✨ Client ${clientId} is ready with ${this.clientChunks[clientId].length} vector chunks.`);
    }

    chunkText(text, maxChars) {
        const overlap = Math.floor(maxChars * 0.15); // 15% overlap for better context
        const paragraphs = text.split(/\n\s*\n/);
        let chunks = [];
        let currentChunk = '';

        for (const p of paragraphs) {
            const cleanP = p.trim();
            if (!cleanP) continue;

            if (cleanP.length > maxChars) {
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }
                
                const sentences = cleanP.match(/[^\.!\?]+[\.!\?]+/g) || [cleanP];
                for (const s of sentences) {
                    if ((currentChunk.length + s.length) < maxChars) {
                        currentChunk += s + ' ';
                    } else {
                        if (currentChunk) chunks.push(currentChunk.trim());
                        // Maintain overlap
                        currentChunk = currentChunk.slice(-overlap) + s + ' ';
                    }
                }
                continue;
            }

            if ((currentChunk.length + cleanP.length) < maxChars) {
                currentChunk += cleanP + '\n\n';
            } else {
                if (currentChunk) chunks.push(currentChunk.trim());
                currentChunk = currentChunk.slice(-overlap) + cleanP + '\n\n';
            }
        }
        if (currentChunk) chunks.push(currentChunk.trim());
        return chunks;
    }

    async getEmbedding(text) {
        const cacheKey = text.trim().toLowerCase();
        if (this.embeddingCache.has(cacheKey)) return this.embeddingCache.get(cacheKey);

        const response = await this.openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: text
        });
        const embedding = response.data[0].embedding;
        
        // Cache management (limit size to 500 entries)
        if (this.embeddingCache.size > 500) this.embeddingCache.delete(this.embeddingCache.keys().next().value);
        this.embeddingCache.set(cacheKey, embedding);
        
        return embedding;
    }

    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    async search(clientId, query, topK = 5) {
        // Auto-reload from GCS if not in memory (handles Cloud Run restarts)
        if (!this.clientChunks[clientId] || this.clientChunks[clientId].length === 0) {
            console.log(`[RAG] ⚠️ No chunks in memory for ${clientId}. Trying GCS sync...`);
            try {
                await this.syncClientFromGCS(clientId);
            } catch (e) {
                console.error(`[RAG] GCS sync failed: ${e.message}`);
            }
        }

        const chunks = this.clientChunks[clientId];
        if (!chunks || chunks.length === 0) return '';

        try {
            const queryEmbedding = await this.getEmbedding(query);
            const results = chunks.map(chunk => ({
                text: chunk.text,
                similarity: this.cosineSimilarity(queryEmbedding, chunk.embedding)
            }));

            results.sort((a, b) => b.similarity - a.similarity);
            
            // Return top results with similarity > 0.18 threshold (very inclusive for multi-topic queries)
            // We take top 8 chunks to cover multiple topics in one go
            const relevant = results.filter(r => r.similarity > 0.18).slice(0, 8);
            
            if (relevant.length === 0) {
                console.log(`[RAG] 🔍 SEARCH FAILED for: "${query}" | Best similarity was: ${results[0]?.similarity.toFixed(2)} (Threshold: 0.18)`);
                return ''; 
            }

            console.log(`[RAG] ✅ SEARCH SUCCESS: Found ${relevant.length} chunks. Best similarity: ${results[0]?.similarity.toFixed(2)}`);
            return relevant.map(r => r.text).join('\n\n---\n\n');
        } catch (error) {
            console.error(`[RAG] Search error for client ${clientId}:`, error.message);
            return '';
        }
    }

    async syncClientFromGCS(clientId) {
        try {
            const files = await gcs.listClientFiles(clientId);
            if (!files || files.length === 0) {
                console.log(`[RAG] No files found in GCS for client ${clientId}`);
                return;
            }

            const clientPath = path.join(this.baseKbPath, clientId);
            if (!fs.existsSync(clientPath)) fs.mkdirSync(clientPath, { recursive: true });

            for (const fileName of files) {
                const localPath = path.join(clientPath, fileName);
                if (!fs.existsSync(localPath)) {
                    console.log(`[RAG] 📥 Downloading ${fileName} from GCS...`);
                    await gcs.downloadFromBucket(clientId, fileName, localPath);
                }
            }

            await this.loadClientKnowledge(clientId, clientId);
            console.log(`[RAG] ✅ GCS sync complete for ${clientId}. ${this.clientChunks[clientId]?.length || 0} chunks loaded.`);
        } catch (err) {
            console.error(`[RAG] syncClientFromGCS error: ${err.message}`);
        }
    }

    async query(clientId, userQuery, chatHistory = []) {
        if (!this.openai) return { text: "I'm sorry, my AI features are currently offline." };
        
        try {
            const lowerQuery = userQuery.toLowerCase().trim();
            
            // 1. LIGHTWEIGHT CONVERSATIONAL LAYER (Greetings/Farewells)
            const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'namaste', 'salam', 'hola'];
            const farewells = ['bye', 'goodbye', 'see you', 'thanks', 'thank you', 'dhanyawad', 'shukriya'];
            
            const isGreeting = greetings.some(g => lowerQuery === g || lowerQuery.startsWith(g + ' '));
            const isFarewell = farewells.some(f => lowerQuery === f || lowerQuery.startsWith(f + ' '));

            if (isGreeting || isFarewell) {
                const prompt = isGreeting 
                    ? "Reply to this greeting politely and professionally as a smart business assistant. Keep it short and friendly. Use the same language as the user."
                    : "Reply to this thank you or farewell politely. Keep it short and professional. Use the same language as the user.";
                
                const completion = await this.openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "You are a professional business assistant. Reply naturally and politely. Do NOT mention RAG or documents." },
                        { role: "user", content: `${prompt}\n\nUser said: ${userQuery}` }
                    ],
                    temperature: 0.7
                });
                return { text: completion.choices[0].message.content.replace(/\*/g, '') };
            }

            // 2. QUERY CONDENSATION (Context Awareness)
            let standaloneQuery = userQuery;
            if (chatHistory && chatHistory.length > 0) {
                console.log(`🧠 [AI] Condensing query using ${chatHistory.length} history messages...`);
                const historyText = chatHistory.map(m => `${m.sender}: ${m.text}`).join('\n');
                const condensation = await this.openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { 
                            role: "system", 
                            content: "You are a query optimizer. Given the following conversation history and a new user message, rewrite the message into a STANDALONE search query that can be used for document retrieval. Keep it concise. If the message is already standalone, just return it as is. NEVER answer the question, only rewrite it." 
                        },
                        { role: "user", content: `HISTORY:\n${historyText}\n\nNEW MESSAGE: ${userQuery}` }
                    ],
                    temperature: 0
                });
                standaloneQuery = condensation.choices[0].message.content.trim();
                console.log(`🧠 [AI] Standalone Query: "${standaloneQuery}"`);
            }

            // 3. IMAGE GENERATION LAYER
            const isImageRequest = /\b(generate|create|make|banao|bana|show)\b.*\b(image|photo|picture|pic|drawing|image)\b/i.test(standaloneQuery.toLowerCase());

            if (isImageRequest) {
                console.log(`🎨 [GEMINI] Generating image for: ${userQuery}`);
                
                const client = new GoogleGenAI({
                    vertexai: true,
                    project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID,
                    location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
                });

                const response = await client.models.generateContentStream({
                    model: 'gemini-1.5-flash', 
                    contents: userQuery,
                    config: {
                        responseModalities: [Modality.TEXT, Modality.IMAGE],
                    },
                });

                let imageBuffer = null;
                for await (const chunk of response) {
                    if (chunk.data) {
                        imageBuffer = chunk.data;
                        break; // Take the first image found
                    }
                }

                if (imageBuffer) {
                    const fileName = `generated_${Date.now()}.png`;
                    const publicUrl = await gcs.uploadToBucket(`generated_images/${clientId}`, fileName, imageBuffer);
                    return { 
                        text: "Here is the image I generated for you using Gemini! 🎨✨", 
                        imageUrl: publicUrl 
                    };
                } else {
                    return { text: "I tried to generate an image but couldn't get the visual data. Please try again!" };
                }
            }

            // 4. RAG LAYER
            const context = await this.search(clientId, standaloneQuery);

            // If no relevant context found, provide a clean "not found" message
            if (!context || context.trim() === '') {
                return { 
                    text: "Maaf kijiye, iss topic ke baare mein mere paas abhi jaankari nahi hai. Kya main kisi aur cheez mein aapki madad kar sakta hoon? 🙏" 
                };
            }

            const systemPrompt = `You are an expert AI Business Assistant. Your goal is to provide premium, human-like customer support using ONLY the provided BUSINESS CONTEXT.

STRICT INSTRUCTIONS:
1. ONLY use information from the BUSINESS CONTEXT. 
2. MULTI-TOPIC SUPPORT: If the user asks about multiple topics at once, look for information on all of them in the context and provide a combined, cohesive response.
3. If information on ANY part of the query is missing, answer what you know and politely ask for more details on the missing parts.
4. If the entire answer is not in the context, say: "Maaf kijiye, iss topic ke baare mein mere paas abhi jaankari nahi hai. Kya main kisi aur cheez mein aapki madad kar sakta hoon?"
5. LANGUAGE: Always reply in the same language as the customer (Hindi, Hinglish, or English).
6. NO TECHNICAL JARGON: Never mention "documents", "context", "database", "chunks", "files", or "RAG".
7. FORMATTING: Use clean, plain text. ABSOLUTELY NO Markdown (no asterisks *, no underscores _, no bold tags).
8. STRUCTURE: Use short paragraphs and clear numbered lists for multiple points or topics.
9. TONE: Professional, confident, and helpful. Sound like a high-end human assistant.
10. WHATSAPP UX: Keep messages concise and easy to read on mobile screens. Use proper line breaks.

BUSINESS CONTEXT:
${context}
`;

            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userQuery }
                ],
                temperature: 0.5
            });

            return { text: completion.choices[0].message.content.replace(/\*/g, '').trim() };

        } catch (err) {
            console.error('[RAG QUERY ERROR]', err);
            return { text: `⚠️ Error: ${err.message}` };
        }
    }

    // Helper to find the correct folder for a client
    getClientFolderPath(clientId) {
        const folders = fs.readdirSync(this.baseKbPath);
        const folder = folders.find(f => f.endsWith(`_${clientId}`) || f === clientId);
        return folder ? path.join(this.baseKbPath, folder) : path.join(this.baseKbPath, clientId);
    }

    // Add a file and re-index for a client
    async addFile(clientId, filename, content) {
        const clientPath = this.getClientFolderPath(clientId);
        if (!fs.existsSync(clientPath)) fs.mkdirSync(clientPath, { recursive: true });
        
        fs.writeFileSync(path.join(clientPath, filename), content);
        await this.loadClientKnowledge(path.basename(clientPath), clientId);
    }

    // Delete a file and re-index for a client
    async deleteFile(clientId, filename) {
        const clientPath = this.getClientFolderPath(clientId);
        const filePath = path.join(clientPath, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            await this.loadClientKnowledge(path.basename(clientPath), clientId);
        }
    }

    getClientFiles(clientId) {
        const clientPath = this.getClientFolderPath(clientId);
        if (!fs.existsSync(clientPath)) return [];
        const supportedExts = ['.txt', '.docx', '.pdf', '.doc', '.xlsx', '.xls'];
        return fs.readdirSync(clientPath).filter(f => supportedExts.includes(path.extname(f).toLowerCase()));
    }
}

module.exports = SimpleRAG;
