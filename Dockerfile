FROM node:20-slim

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm install --production

# Copy application source
COPY . .

# Create necessary directories
RUN mkdir -p uploads knowledge_base

# Expose the application port
EXPOSE 8080

# Start the application
CMD ["npm", "start"]
