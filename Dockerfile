FROM docker:dind
RUN apk --no-cache update
RUN apk --no-cache add git nodejs npm
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --production
RUN npm cache clean --force
ENV NODE_ENV="production"
COPY . .
CMD [ "npm", "start" ]
