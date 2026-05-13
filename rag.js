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
            // Standardize: If folder name contains an underscore, the part after the last underscore is the ID.
            // Otherwise, the entire folder name is the ID.
            const parts = folderName.split('_');
            const clientId = parts[parts.length - 1];

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

        const allChunksForClient = [];
        const chunksToEmbed = [];

        for (const file of files) {
            console.log(`[RAG] 📄 Processing: ${file}...`);
            let content = await this.extractTextFromFile(path.join(clientPath, file));
            if (!content || content.trim().length === 0) continue;

            const rawChunks = this.chunkText(content, 1500);
            console.log(`[RAG] ✂️ Split ${file} into ${rawChunks.length} chunks.`);

            for (let i = 0; i < rawChunks.length; i++) {
                let chunk = rawChunks[i].trim();
                if (!chunk) continue;
                
                const cleanFileName = file.replace(/^\d+[\s_-]*/, '').replace(/\.[^/.]+$/, "").replace(/_/g, " ").replace(/-/g, " ");
                const chunkWithMeta = `[Source Document: ${cleanFileName}]\n${chunk}`;
                
                chunksToEmbed.push({ text: chunkWithMeta, source: file });
            }
        }

        // BATCH EMBEDDING (Up to 100 chunks at a time for speed)
        const batchSize = 100;
        for (let i = 0; i < chunksToEmbed.length; i += batchSize) {
            const batch = chunksToEmbed.slice(i, i + batchSize);
            console.log(`[RAG] 🧠 Embedding Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(chunksToEmbed.length/batchSize)} (${batch.length} chunks)...`);
            
            try {
                const response = await this.openai.embeddings.create({
                    model: 'text-embedding-3-small',
                    input: batch.map(b => b.text)
                });

                response.data.forEach((item, index) => {
                    allChunksForClient.push({
                        text: batch[index].text,
                        embedding: item.embedding,
                        source: batch[index].source
                    });
                });
            } catch (err) {
                console.error(`[RAG] ❌ Batch Embedding Error:`, err.message);
            }
        }

        this.clientChunks[clientId] = allChunksForClient;
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

    async search(clientId, query, topK = 15) {
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
        if (!chunks || chunks.length === 0) {
            console.log(`[RAG] ❌ No chunks available for ${clientId} after sync attempt.`);
            return '';
        }

        try {
            console.log(`[RAG] 🔍 Searching for: "${query}" across ${chunks.length} chunks...`);
            const queryEmbedding = await this.getEmbedding(query);
            const results = chunks.map(chunk => ({
                text: chunk.text,
                similarity: this.cosineSimilarity(queryEmbedding, chunk.embedding),
                source: chunk.source
            }));

            results.sort((a, b) => b.similarity - a.similarity);
            
            // Log top 3 similarities for debugging
            results.slice(0, 3).forEach((r, i) => {
                console.log(`   Rank ${i+1}: [Sim: ${r.similarity.toFixed(4)}] Source: ${r.source}`);
            });

            // Even more inclusive threshold for maximum retrieval
            const relevant = results.filter(r => r.similarity > 0.05).slice(0, topK);
            
            if (relevant.length === 0) {
                console.log(`[RAG] 🔍 SEARCH FAILED: No chunks above threshold. Best: ${results[0]?.similarity.toFixed(4)}`);
                return ''; 
            }

            console.log(`[RAG] ✅ SEARCH SUCCESS: Found ${relevant.length} chunks.`);
            return relevant.map(r => r.text).join('\n\n---\n\n');
        } catch (error) {
            console.error(`[RAG] Search error:`, error.message);
            return '';
        }
    }

    async syncClientFromGCS(clientId) {
        try {
            console.log(`[RAG] 🔄 Syncing GCS for client: ${clientId}`);
            const files = await gcs.listClientFiles(clientId);
            if (!files || files.length === 0) {
                console.log(`[RAG] No files in GCS bucket for ${clientId}`);
                return;
            }

            // Use the consistent folder path logic
            const clientPath = this.getClientFolderPath(clientId);
            if (!fs.existsSync(clientPath)) fs.mkdirSync(clientPath, { recursive: true });

            for (const fileName of files) {
                const localPath = path.join(clientPath, fileName);
                if (!fs.existsSync(localPath) || fs.statSync(localPath).size < 10) {
                    console.log(`[RAG] 📥 Downloading ${fileName} from GCS...`);
                    await gcs.downloadFromBucket(clientId, fileName, localPath);
                }
            }

            // FORCE RE-INDEX using the folder name only
            const folderName = path.basename(clientPath);
            await this.loadClientKnowledge(folderName, clientId);
            console.log(`[RAG] ✨ Client ${clientId} is READY with ${this.clientChunks[clientId]?.length || 0} chunks.`);
        } catch (err) {
            console.error(`[RAG] syncClientFromGCS Error:`, err.message);
        }
    }

    async query(clientId, userQuery, chatHistory = [], clientName = "AISA Connect") {
        if (!this.openai) return { text: "I'm sorry, my AI features are currently offline." };
        
        try {
            const lowerQuery = userQuery.toLowerCase().trim();
            
            // 1. LIGHTWEIGHT CONVERSATIONAL LAYER (Greetings/Farewells)
            const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'namaste', 'salam', 'hola', 'kaise ho', 'how are you'];
            const farewells = ['bye', 'goodbye', 'see you', 'thanks', 'thank you', 'dhanyawad', 'shukriya'];
            
            const isGreeting = greetings.some(g => lowerQuery === g || lowerQuery.startsWith(g + ' '));
            const isFarewell = farewells.some(f => lowerQuery === f || lowerQuery.startsWith(f + ' '));

            if (isGreeting || isFarewell) {
                const prompt = isGreeting 
                    ? `Greet the user warmly as a senior professional representative of ${clientName}. Mention that you are their dedicated AI Assistant and can help with any business inquiries using official records. Tone: Professional & Welcoming.`
                    : "Politely say goodbye or you're welcome. Encourage them to reach out again if they need further assistance. Tone: Professional & Courteous.";
                
                const completion = await this.openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: `You are a high-level Professional AI Business Assistant for ${clientName}. Use a sophisticated yet friendly tone. Use 1-2 relevant emojis. Respond in the same language/style as the user (English, Hindi, or Hinglish). Do NOT use markdown headers (###).` },
                        { role: "user", content: `${prompt}\n\nUser said: ${userQuery}` }
                    ],
                    temperature: 0.4
                });
                return { text: completion.choices[0].message.content.trim() };
            }

            // 2. QUERY CONDENSATION (Context Awareness) - Optimized for SPEED & BRAND-AWARENESS
            let standaloneQuery = userQuery;
            const pronouns = ['this', 'it', 'they', 'them', 'those', 'these', 'that', 'he', 'she', 'iske', 'woh', 'yeh', 'unka', 'iska', 'pricing', 'price', 'rates', 'details'];
            const needsCondensation = pronouns.some(p => lowerQuery.includes(p)) || lowerQuery.length < 10;

            if (chatHistory && chatHistory.length > 0 && needsCondensation) {
                console.log(`🧠 [AI] Condensing query (History + Brand Focus)...`);
                const historyText = chatHistory.slice(-3).map(m => `${m.sender}: ${m.text}`).join('\n');
                const condensation = await this.openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { 
                            role: "system", 
                            content: `You are an expert query optimizer. Convert the user's latest message into a STANDALONE search query. If a specific topic was discussed previously (e.g. pricing, features, company info), ensure it is included in the new query to avoid ambiguity. Extract only core keywords. Return ONLY the query.` 
                        },
                        { role: "user", content: `HISTORY:\n${historyText}\n\nNEW MESSAGE: ${userQuery}` }
                    ],
                    temperature: 0,
                    max_tokens: 40
                });
                standaloneQuery = condensation.choices[0].message.content.trim();
                console.log(`🧠 [AI] Brand-Aware Query: "${standaloneQuery}"`);
            } else if (lowerQuery.split(' ').length > 4) {
                console.log(`🚀 [AI] Fast-tracking long query: "${userQuery}"`);
                standaloneQuery = userQuery.replace(/kaise ho|mein badiya hu|i am fine|hello|hi/gi, '').trim();
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
                        text: "Here is the image I generated for you! 🎨✨", 
                        imageUrl: publicUrl 
                    };
                } else {
                    return { text: "I tried to generate an image but couldn't get the visual data. Please try again!" };
                }
            }

            // 4. RAG LAYER
            let contextText = await this.search(clientId, standaloneQuery);
            
            // SECOND CHANCE: If standalone query found nothing, try the original query
            if (!contextText && standaloneQuery !== userQuery) {
                console.log(`🔍 [AI] Standalone query found nothing. Retrying with original: "${userQuery}"`);
                contextText = await this.search(clientId, userQuery);
            }

            const systemPrompt = `
You are the Official AI Knowledge Assistant for ${clientName}. Your goal is to provide highly professional, convincing, and accurate information based ONLY on official documents.

STRICT OPERATIONAL GUIDELINES:
1. DOCUMENT-BASED ANSWERS: Your response must be derived 100% from the context below. If the information is missing, politely inform the user that it's not in the official records.
2. CONVINCING & PERSUASIVE: Use a confident, senior-level professional tone. Speak like an expert who knows the business inside out.
3. LANGUAGE & STYLE: Respond in the language used by the user (English, Hindi, or Hinglish). Maintain a consistent professional flow.
4. FORMATTING: 
   - Use subtle emojis (📈, ✅, 🤝, 🚀, 💼) to make the text readable and modern.
   - Keep paragraphs short and crisp.
   - NO markdown symbols like # or *. Keep it clean for WhatsApp.
5. NO HALLUCINATIONS: Do not guess. If a price or detail isn't in the context, do not make it up.

Context from official business documents:
--------------------------------------------------
${contextText || "CRITICAL: NO RELEVANT DOCUMENTS FOUND. Inform the user that you don't have information on this topic in your records."}
--------------------------------------------------
`;

            // Prepare messages with History for ChatGPT-like flow
            const messages = [
                { role: "system", content: systemPrompt }
            ];

            // Add history (mapped to OpenAI roles)
            if (chatHistory && chatHistory.length > 0) {
                chatHistory.forEach(m => {
                    messages.push({ 
                        role: m.sender === 'bot' ? 'assistant' : 'user', 
                        content: m.text 
                    });
                });
            }

            // Add the current user query (or standalone query)
            messages.push({ role: "user", content: userQuery });

            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: messages,
                temperature: 0.4
            });

            let finalResponse = completion.choices[0].message.content.trim();
            finalResponse = finalResponse.replace(/[#*]/g, '');
            return { text: finalResponse };

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
