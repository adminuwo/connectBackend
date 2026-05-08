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
                
                // Add Source Metadata to the chunk text
                const chunkWithMeta = `[Source Document: ${file}]\n${chunk}`;

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
        // First split by double newlines (paragraphs)
        const paragraphs = text.split('\n\n');
        let chunks = [];
        let currentChunk = '';

        for (const p of paragraphs) {
            // If a single paragraph is larger than maxChars, break it down further
            if (p.length > maxChars) {
                if (currentChunk.trim()) chunks.push(currentChunk.trim());
                currentChunk = '';
                
                const subChunks = p.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) || [];
                chunks = chunks.concat(subChunks);
                continue;
            }

            if ((currentChunk.length + p.length) < maxChars) {
                currentChunk += p + '\n\n';
            } else {
                if (currentChunk.trim()) chunks.push(currentChunk.trim());
                currentChunk = p + '\n\n';
            }
        }
        if (currentChunk.trim()) chunks.push(currentChunk.trim());
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
            // Return top results with similarity > 0.35 threshold (stricter for better accuracy)
            const relevant = results.filter(r => r.similarity > 0.35).slice(0, topK);
            
            if (relevant.length === 0) {
                console.log(`[RAG] 🔍 No relevant context found for query: "${query}" (Top similarity: ${results[0]?.similarity.toFixed(2)})`);
                return ''; // No relevant context found
            }
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

    async query(clientId, userQuery) {
        if (!this.openai) return { text: "I'm sorry, my AI features are currently offline." };
        
        try {
            const lowerQuery = userQuery.toLowerCase();
            const isImageRequest = /\b(generate|create|make|banao|bana|show)\b.*\b(image|photo|picture|pic|drawing|image)\b/i.test(lowerQuery);

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

            const context = await this.search(clientId, userQuery);

            // If no relevant context found, provide the specific "not found" message with available topics
            if (!context || context.trim() === '') {
                const chunks = this.clientChunks[clientId] || [];
                const topics = [...new Set(chunks.map(c => c.source))];
                
                if (topics.length === 0) {
                    return { text: "Maaf kijiye, abhi is business ki koi jaankari mere paas nahi hai. 🙏" };
                }

                let response = "Iss topic ke baare mein mere paas abhi jaankari nahi hai. 🙏\n\nAap mujhse in topics ke baare mein puch sakte hain:\n";
                topics.forEach(t => {
                    const cleanName = t.replace(/\.[^/.]+$/, "").replace(/_/g, " ").replace(/-/g, " ");
                    response += `• ${cleanName.charAt(0).toUpperCase() + cleanName.slice(1)}\n`;
                });
                response += "\nKripya inme se kisi topic par sawal puchein! ✨";
                return { text: response };
            }

            const systemPrompt = `You are a helpful and professional AI assistant for this business. 
Your goal is to answer customer questions accurately using ONLY the context provided below.

RULES:
1. ONLY use information from the BUSINESS CONTEXT. 
2. If the answer is not there, say: "Maaf kijiye, iss topic ke baare mein mere paas info nahi hai. 🙏"
3. Use the same language as the customer (Hindi/Hinglish/English).
4. Keep responses concise, friendly, and helpful.
5. Use bullet points (using simple dashes - or dots •) for lists.
6. **IMPORTANT**: DO NOT use any Markdown formatting like asterisks (*), underscores (_), or bold tags. Keep text clean and plain.
7. End with a polite closing or a relevant question to keep the conversation going.

BUSINESS CONTEXT:
${context}

Strictly follow the context. Do not use outside knowledge.`;

            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userQuery }
                ],
                temperature: 0.5
            });

            return { text: completion.choices[0].message.content };

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
