FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY . ./

ENV NODE_ENV=production
ENV DEMO_MODE=true
ENV HOST=0.0.0.0

EXPOSE 4173
CMD ["node", "server.js"]
