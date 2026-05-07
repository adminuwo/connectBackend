const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const WordExtractor = require("word-extractor");
const extractor = new WordExtractor();
const XLSX = require('xlsx');

class SimpleRAG {
    constructor(openai) {
        this.openai = openai;
        this.clientChunks = {}; // Store { clientId: [{ text: string, embedding: number[] }] }
        this.baseKbPath = path.join(__dirname, 'knowledge_base');
    }

    // Initialize and load knowledge base for all clients
    async init() {
        if (!fs.existsSync(this.baseKbPath)) {
            fs.mkdirSync(this.baseKbPath);
        }

        const clientFolders = fs.readdirSync(this.baseKbPath).filter(f => fs.lstatSync(path.join(this.baseKbPath, f)).isDirectory());
        
        for (const folderName of clientFolders) {
            // Extract ID from Name_ID format
            const parts = folderName.split('_');
            const clientId = parts[parts.length - 1]; // Assume ID is always the last part
            
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

        let allText = '';
        for (const file of files) {
            console.log(`[RAG] 📄 Extracting text from: ${file}...`);
            const content = await this.extractTextFromFile(path.join(clientPath, file));
            console.log(`[RAG] ℹ️ Extracted ${content.length} characters from ${file}`);
            allText += content + '\n\n';
        }

        if (allText.trim().length === 0) {
            console.log(`[RAG] ⚠️ No text found in any documents for client ${clientId}`);
            return;
        }

        const rawChunks = this.chunkText(allText, 800);
        console.log(`[RAG] ✂️ Split text into ${rawChunks.length} chunks.`);
        
        for (let i = 0; i < rawChunks.length; i++) {
            const chunk = rawChunks[i];
            if (chunk.trim().length === 0) continue;
            
            if (!this.openai) {
                console.warn(`[RAG] ⚠️ Skipping embedding for chunk ${i+1}: OpenAI client not initialized.`);
                continue;
            }

            try {
                process.stdout.write(`[RAG] 🧠 Generating embedding ${i+1}/${rawChunks.length}... \r`);
                const embedding = await this.getEmbedding(chunk);
                this.clientChunks[clientId].push({ text: chunk, embedding });
            } catch (err) {
                console.error(`\n[RAG] ❌ Embedding Error for client ${clientId} (Chunk ${i}):`, err.message);
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
        const response = await this.openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: text
        });
        return response.data[0].embedding;
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

    async search(clientId, query, topK = 3) {
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
        if (!this.openai) return "I'm sorry, my AI features are currently offline.";
        
        try {
            const context = await this.search(clientId, userQuery);
            const systemPrompt = `You are an elite, highly persuasive sales consultant and AI business partner. 
            Your goal is to provide professional, clear, and extremely convincing responses that drive sales and user engagement.

            STRICT RULE:
            - **NO GREETINGS**: Never start your response with "Welcome", "Hello", "Hi", "Greetings", or "Namaste". The workflow already handled the greeting. Go STRAIGHT to the information or sales logic.

            STRATEGIC GUIDELINES:
            - **Be Convincing**: Highlight key benefits, ROI, and unique selling points (USPs) of the products (e.g., AI Legal, AI Ads).
            - **Sales-Driven**: Always nudge the user toward a positive action (booking, buying, or inquiring more) with a strong Call to Action (CTA).
            - **Professional Tone**: Stay sophisticated yet accessible. Use a consultative approach.

            FORMATTING FOR WHATSAPP (CRITICAL):
            - **Spacing**: Use double newlines (Enter twice) after every 2-3 short sentences. No walls of text.
            - **Boldness**: Use *asterisks* to *bold* key terms, product names, and benefits. 
            - **Emojis**: Integrate relevant emojis **throughout the message** (not just at the end) to build rapport and highlight points. 
            - **Lists**: Use checkmarks (✅) or points (•) for feature lists.

            If information is missing from the context, use your expert AI knowledge to provide a compelling and logical sales response.

            CONTEXT:
            ${context || 'No specific context found.'}
            `;

            const completion = await this.openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userQuery }
                ],
                temperature: 0.8
            });

            return completion.choices[0].message.content;
        } catch (err) {
            console.error('[RAG QUERY ERROR]', err.message);
            return "I'm having trouble processing that right now. Please try again later.";
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
