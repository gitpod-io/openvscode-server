# Deploy OpenVSCode Server to dokku

## Prerequisites

To complete this guide, you need:

- An installation of [Dokku](https://dokku.com/docs/getting-started/installation/)
- DNS for your app name pointing at your server (replace `dokku.me` in this guide for your domain name)
- (Optional) The [dokku-letsencrypt](https://github.com/dokku/dokku-letsencrypt) plugin
- (Optional) The [dokku-http-auth](https://github.com/dokku/dokku-http-auth) plugin

## Setup

1. Create the app:
    ```shell
    dokku apps:create code
    ```
2. Create the code directory. Your workspace will be mounted here
    ```shell
    dokku storage:ensure-directory --chown heroku code
    dokku storage:mount code "/var/lib/dokku/data/storage/code:/home/workspace:cached"
    ```
3. Override the proxy ports to route requests from the host port 80 to the container 3000
    ```shell
    dokku proxy:ports-set code http:80:3000
    ```
4. Deploy OpenVSCode Server from a docker image.
    ```shell
    dokku git:from-image code gitpod/openvscode-server
    ```
5. (Optional) Enable http auth for your server. In the below example, the username is `root` and the password is whatever you would like, such as `4f76badc-e6df-4bb0-9a39-aa1b1ceb386c`
    ```shell
    dokku http-auth:on code root 4f76badc-e6df-4bb0-9a39-aa1b1ceb386c
    ```
6. (Optional) Enable ssl via letsencrypt.
    ```shell
    dokku letsencrypt:enable code
    ```
## Start the server

The server should be automatically started by the above commands.

## Access OpenVSCode Server

> This assumes your hostname

To access OpenVSCode Server, browse to:

- `http`: [http://code.dokku.me](http://code.dokku.me)
- `https`: [https://code.dokku.me](https://code.dokku.me)

## Teardown

1. Run the following command to destroy the app and all related resources:
    ```shell
    dokku --force apps:destroy code
    ```
