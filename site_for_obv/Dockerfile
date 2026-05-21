FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY app.js index.html admin.html ./

RUN mkdir -p data uploads

EXPOSE 3000

CMD ["npm", "start"]
