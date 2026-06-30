# Step 1: Grab a lightweight, pre-configured Node.js environment
FROM node:20-slim

# Step 2: Create a directory inside the container for our code
WORKDIR /app

# Step 3: Copy ALL files (including server.js and index.html) into that folder
COPY . .

# Step 4: Open up port 3000 so we can access the backend
EXPOSE 3000

# Step 5: The command to run when the container starts
CMD ["node", "server.js"]