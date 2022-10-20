# fancy-bot

> A GitHub App built with [Probot](https://github.com/probot/probot) that should do ci cd with github actions, travis ci and argo
test
## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker-compose up -d
```

# Deploy with Heroku

```sh
# 1. Download public key from this repo (public-key.pem)

# 2. Get your API-Key from heroku and save it to a txt file

# 3. Encrypt the text file with public key with following command
openssl rsautl -encrypt -pubin -inkey pub.key -in api_key.txt | base64 > encrypted_api_key.txt

# 4. Save the text of encrypted_api_key.txt in ci_cd.yml with the line breaks replaced with \n
```

## Contributing

If you have suggestions for how fancy-bot could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[ISC](LICENSE) © 2022 LLeeJr <legralisandro@gmail.com>

