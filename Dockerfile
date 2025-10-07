# Cloud-ready Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --production
COPY . .
ENV NODE_ENV=production
# Expose port (cloud provider may override)
EXPOSE 3000
CMD ["node", "server.js"]
