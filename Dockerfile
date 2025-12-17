# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code and config
COPY . .

# Build the application
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist

# Create a non-root user for security
RUN addgroup -S wotmcp && adduser -S wotmcp -G wotmcp
USER wotmcp

# Expose the default port for streamable-http mode
EXPOSE 3000

# Set the entrypoint
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--help"]
