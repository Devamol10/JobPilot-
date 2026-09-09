# Use official Microsoft Playwright image (includes Node & Chromium browser dependencies)
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Ensure matching Playwright Chromium binary is installed
RUN npx playwright install --with-deps chromium

# Copy full application code
COPY . .

# Expose port (Render/Railway dynamically pass PORT env)
EXPOSE 3000

# Start server
CMD ["npm", "start"]
