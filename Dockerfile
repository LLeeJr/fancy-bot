FROM docker:dind
RUN apk --no-cache update
RUN apk --no-cache add git nodejs npm bash curl
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --production
RUN npm cache clean --force
ENV NODE_ENV="production"
COPY . .
ENTRYPOINT ["./startup.sh"]
