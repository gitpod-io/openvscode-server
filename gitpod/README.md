# Gitpod VS Code Browser

## Build with local cache

Prepare for build and login gcloud

```sh
# One time exec if you didn't change source code
# If workspace comes from a prebuild, then you can skip this command, see task `Build Prepare` in .gitpod.yml file
npm run gulp compile-build-without-mangling
npm run gulp extensions-ci \
    && npm run gulp minify-vscode-reh \
    && npm run gulp vscode-web-min-ci \
    && npm run gulp vscode-reh-linux-x64-min-ci
```

```sh
sudo apt-get update
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
sudo apt-get update && sudo apt-get install -y google-cloud-cli
gcloud auth configure-docker --quiet
gcloud auth login
```

Build image

```sh
# exec gulp task depends on your needs i.e. `npm run gulp vscode-web-min-ci`
# copy workbench*.html into `out-build` if you only change this
# exec `npm run gulp compile-build` if you changed codebase
npm run gulp vscode-web-min-ci
docker buildx build -t eu.gcr.io/gitpod-dev-artifact/build/ide/code:nightly .. -f gitpod/Dockerfile --push
```

## Use latest build in Gitpod Preview Env

1. Open workspace with gitpod-io/gitpod repository (with a branch which has preview env ready)
2. Exec commands below and wait for 20 more seconds

```
cd /workspace/gitpod/components/ide/gha-update-image
leeway run .:code-use-dev-latest
```

3. Configure your Editor Setting to use `latest` VS Code Browser
4. Open a workspace in preview env, (with example repo https://github.com/gitpod-io/empty)
5. Restart workspace from step 4 if you rebuild the image
