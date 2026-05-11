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

    async search(clientId, query, topK = 10) {
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
            console.log(`[RAG] ❌ No chunks available for ${clientId}`);
            return '';
        }

        try {
            const queryEmbedding = await this.getEmbedding(query);
            const results = chunks.map(chunk => ({
                text: chunk.text,
                similarity: this.cosineSimilarity(queryEmbedding, chunk.embedding)
            }));

            results.sort((a, b) => b.similarity - a.similarity);
            
            // HYPER-INCLUSIVE THRESHOLD (0.10) for maximum retrieval
            const relevant = results.filter(r => r.similarity > 0.10).slice(0, topK);
            
            if (relevant.length === 0) {
                console.log(`[RAG] 🔍 SEARCH FAILED for: "${query}" | Best similarity: ${results[0]?.similarity.toFixed(2)}`);
                return ''; 
            }

            console.log(`[RAG] ✅ SEARCH SUCCESS: Found ${relevant.length} chunks. Best similarity: ${results[0]?.similarity.toFixed(2)}`);
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

            const clientPath = path.join(this.baseKbPath, clientId);
            if (!fs.existsSync(clientPath)) fs.mkdirSync(clientPath, { recursive: true });

            for (const fileName of files) {
                const localPath = path.join(clientPath, fileName);
                // Force redownload if file is small (possible corrupt upload) or not exists
                if (!fs.existsSync(localPath) || fs.statSync(localPath).size < 10) {
                    console.log(`[RAG] 📥 Downloading ${fileName} from GCS...`);
                    await gcs.downloadFromBucket(clientId, fileName, localPath);
                }
            }

            // FORCE RE-INDEX
            await this.loadClientKnowledge(clientId, clientId);
            console.log(`[RAG] ✨ Client ${clientId} is READY with ${this.clientChunks[clientId]?.length || 0} chunks.`);
        } catch (err) {
            console.error(`[RAG] syncClientFromGCS Error:`, err.message);
        }
    }

    async query(clientId, userQuery, chatHistory = []) {
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
                    ? "Reply to this greeting as a high-end sales expert. Be welcoming, professional, and slightly persuasive. Mention that you are ready to help them grow their business. Use the same language as the user."
                    : "Reply to this thank you or farewell politely. Encourage them to return if they have more questions. Use the same language as the user.";
                
                const completion = await this.openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: "You are a professional AI Sales Specialist. Reply naturally, politely, and persuasively. Use emojis. Do NOT use markdown headers (###)." },
                        { role: "user", content: `${prompt}\n\nUser said: ${userQuery}` }
                    ],
                    temperature: 0.7
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
                            content: "You are an expert query optimizer. Convert the user's latest message into a STANDALONE search query. If a specific brand or topic was discussed previously (e.g. Aimall, AISA, Legal AI), ensure it is included in the new query to avoid ambiguity. Extract only core keywords. Return ONLY the query." 
                        },
                        { role: "user", content: `HISTORY:\n${historyText}\n\nNEW MESSAGE: ${userQuery}` }
                    ],
                    temperature: 0,
                    max_tokens: 30
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
                        text: "Here is the image I generated for you using Gemini! 🎨✨", 
                        imageUrl: publicUrl 
                    };
                } else {
                    return { text: "I tried to generate an image but couldn't get the visual data. Please try again!" };
                }
            }

            // 4. RAG LAYER
            let context = await this.search(clientId, standaloneQuery);
            
            // SECOND CHANCE: If standalone query found nothing, try the original query
            if (!context && standaloneQuery !== userQuery) {
                console.log(`🔍 [AI] Standalone query found nothing. Retrying with original: "${userQuery}"`);
                context = await this.search(clientId, userQuery);
            }

            // If no relevant context found, we still call the LLM to provide a polite "I don't know" in the user's language.
            const systemPrompt = `You are a high-conversion AI Sales & Lead Generation Specialist. Your goal is to provide premium, persuasive, and human-like business support.

            STRICT INSTRUCTIONS:
            1. LEAD GENERATION: Your primary goal is to convince the user and generate a lead. Use persuasive and "convincing" language. At the end of helpful answers, politely suggest a next step (e.g., "Would you like to schedule a personalized demo?" or "Should I have our expert call you to discuss this further?").
            2. BUSINESS CONTEXT: Use the provided context below. If the information is NOT in the context, politely inform the user and ask for their contact details so an expert can get back to them.
            3. LANGUAGE & TONE: Professional, energetic, and highly helpful. Use the EXACT SAME LANGUAGE as the user (English, Hindi, or Hinglish).
            4. VISUAL ALIGNMENT & SPACING: 
               - Use relevant EMOJIS (✅, 🚀, 💎, 📈, ✨) at the start of every key point as bullets.
               - Use DOUBLE LINE BREAKS (empty lines) between every paragraph and point to ensure the message looks clean and spacious on WhatsApp.
            5. WHATSAPP FORMATTING: Use *bold* for key terms, headings, or product names. Ensure there are NO SPACES between the asterisks and the word (e.g., use *Service Name*, NOT * Service Name *).
            6. CLEANLINESS: Do NOT use markdown headers (###), tables, or raw asterisks (*) as bullets. Use emojis or dots (•) instead.

            BUSINESS CONTEXT:
            ${context || "No specific information found in company records. Focus on being helpful and capturing user interest."}
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
                temperature: 0.5
            });

            return { text: completion.choices[0].message.content.trim() };

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
