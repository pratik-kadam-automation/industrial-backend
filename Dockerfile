# Match production (oracle-vpn runs Node v20)
FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests first so Docker can cache this layer —
# it only re-runs npm install when package.json actually changes,
# not on every code edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Now copy the rest of the source
COPY . .

# Never bake secrets into an image — .env stays out via .dockerignore
EXPOSE 3000

CMD ["node", "server.js"]
