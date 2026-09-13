FROM node:22-alpine

# Set working directory
WORKDIR /app

# Install dependencies first to leverage Docker layer cache
COPY package*.json ./

# npm ci is faster and more reliable than npm install for CI/CD/Docker
RUN npm ci --omit=dev && npm cache clean --force

# Copy the rest of the application code
COPY . .

# Runtime configuration
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    WEBUI_ENABLED=true

# Security: Run as non-root user (provided by node image)
USER node

# Expose port
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start command (direct node execution is better for signal handling)
CMD ["node", "src/server.js"]
