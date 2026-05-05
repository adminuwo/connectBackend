# Use an official Node runtime as a parent image
FROM node:20-slim

# Create and change to the app directory
WORKDIR /app

# Copy application dependency manifests to the container image.
# A wildcard is used to ensure both package.json and package-lock.json are copied.
# Copying this separately prevents re-running npm install on every code change.
COPY package*.json ./

# Install production dependencies.
RUN npm install --production

# Copy local code to the container image.
COPY . .

# Set environment variables
ENV PORT=8080
ENV NODE_ENV=production

# Expose the port the app runs on
EXPOSE 8080

# Start the application. 
# Using exec form of CMD for better signal handling
CMD ["node", "server.js"]
