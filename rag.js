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
            const content = await this.extractTextFromFile(path.join(clientPath, file));
            if (!content || content.trim().length === 0) continue;

            const rawChunks = this.chunkText(content, 800);
            console.log(`[RAG] ✂️ Split ${file} into ${rawChunks.length} chunks.`);

            for (let i = 0; i < rawChunks.length; i++) {
                let chunk = rawChunks[i].trim();
                if (!chunk) continue;
                
                // Add Source Metadata to the chunk text
                const chunkWithMeta = `[Source Document: ${file}]\n${chunk}`;

                try {
                    process.stdout.write(`[RAG] 🧠 Embedding ${file} (Part ${i+1}/${rawChunks.length})... \r`);
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
        const chunks = this.clientChunks[clientId];
        if (!chunks || chunks.length === 0) return '';

        try {
            const queryEmbedding = await this.getEmbedding(query);
            const results = chunks.map(chunk => ({
                text: chunk.text,
                similarity: this.cosineSimilarity(queryEmbedding, chunk.embedding)
            }));

            results.sort((a, b) => b.similarity - a.similarity);
            return results.slice(0, topK).map(r => r.text).join('\n\n---\n\n');
        } catch (error) {
            console.error(`[RAG] Search error for client ${clientId}:`, error.message);
            return '';
        }
    }

    async query(clientId, userQuery) {
        if (!this.openai) return { text: "I'm sorry, my AI features are currently offline." };
        
        try {
            const lowerQuery = userQuery.toLowerCase();
            const isImageRequest = lowerQuery.includes('generate image') || 
                                  lowerQuery.includes('create image') || 
                                  lowerQuery.includes('photo of') || 
                                  lowerQuery.includes('image of') ||
                                  lowerQuery.includes('image banao') ||
                                  lowerQuery.includes('photo banao');

            if (isImageRequest) {
                console.log(`🎨 [GEMINI] Generating image for: ${userQuery}`);
                
                const client = new GoogleGenAI({
                    vertexai: true,
                    project: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID,
                    location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
                });

                const response = await client.models.generateContentStream({
                    model: 'gemini-2.5-flash-image',
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
                    console.log(`✅ [GEMINI] Image generated and uploaded: ${publicUrl}`);
                    
                    return { 
                        text: "Here is the image I generated for you using Gemini! 🎨✨", 
                        imageUrl: publicUrl 
                    };
                } else {
                    return { text: "I tried to generate an image but couldn't get the visual data. Please try again with a clearer prompt!" };
                }
            }

            const context = await this.search(clientId, userQuery);
            const systemPrompt = `You are *Antigravity AI*, an elite, high-performance sales strategist and business consultant. 
            Your mission is to provide world-class, extremely persuasive, and polished responses that WOW the user and drive high-value sales.

            💎 **THE ANTIGRAVITY PERSONA**:
            - **Elite & Sophisticated**: Speak with the authority of a top-tier consultant. You are not just a bot; you are a strategic partner.
            - **Hyper-Convincing**: Focus on ROI, benefits, and the "unfair advantage" the client gets by using these services.
            - **Radiant Energy**: Be warm, professional, and high-energy. Use vibrant emojis (2-4 per response) to highlight key points, but keep it classy.
            - **Strategic Formatting**: Use clean spacing and bullet points to make the response extremely easy to read on mobile. **NEVER use asterisks (*)** for bolding or any other purpose. Keep all text plain but highly impactful.

            ✨ **STYLE GUIDELINES**:
            - **Opening**: Acknowledge the user warmly (e.g., "Great question!", "I'd be happy to explain the power of...").
            - **Core Value**: Always link your answer back to how it helps the user scale or save time.
            - **Visuals**: Use icons like 🚀, ⚡, 💎, ✅, or 📈 to draw attention to key benefits.
            - **Closing**: Always end with a powerful, singular Call to Action (CTA) or a provocative question on its own separate line.

            🛠️ **CONTEXTUAL INTELLIGENCE**:
            - **Source Integrity**: Your first priority is the provided CONTEXT. If the user asks for specific data (like **Pricing**, **Plans**, or **Technical Specs**) and it is NOT explicitly mentioned in the context, do NOT make up an answer or provide general "filler" sales talk.
            - **Honest Fallback**: If information is missing, politely state that this specific detail is not currently available in the documentation. 
            - **No Hallucinations**: Never invent features or numbers.
            - **Source Respect**: Pay close attention to source document tags.

            CONTEXT:
            ${context || 'No specific context found.'}
            `;

            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userQuery }
                ],
                temperature: 0.75
            });

            return { text: completion.choices[0].message.content };
        } catch (err) {
            console.error('[RAG QUERY ERROR]', err.message);
            return { text: "I'm experiencing a brief technical glitch. Please give me a moment and try again! 🚀" };
        }
    }

    // Add a file and re-index for a client
    async addFile(clientId, filename, content) {
        const clientPath = path.join(this.baseKbPath, clientId);
        if (!fs.existsSync(clientPath)) fs.mkdirSync(clientPath, { recursive: true });
        
        fs.writeFileSync(path.join(clientPath, filename), content);
        await this.loadClientKnowledge(clientId);
    }

    // Delete a file and re-index for a client
    async deleteFile(clientId, filename) {
        const filePath = path.join(this.baseKbPath, clientId, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            await this.loadClientKnowledge(clientId);
        }
    }

    getClientFiles(clientId) {
        const clientPath = path.join(this.baseKbPath, clientId);
        if (!fs.existsSync(clientPath)) return [];
        const supportedExts = ['.txt', '.docx', '.pdf', '.doc'];
        return fs.readdirSync(clientPath).filter(f => supportedExts.includes(path.extname(f).toLowerCase()));
    }
}

module.exports = SimpleRAG;
