# Deploy OpenVSCode Server to Render

## Prerequisites

To complete this guide, you need:

- a [Render](https://render.com/) account

## Setup

To deploy to Render, click the following button and follow the instructions:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/gitpod-openvscode-server)

After that, create a name for the service group (for example `OpenVSCode Server`) and click <kbd>Apply</kbd>.

## Start the server

Render starts the server automatically.

## Access OpenVSCode Server

When the deployment is complete, you will see your server listed in the <kbd>Services</kbd> section of the Dashboard. Click the dashboard entry to see your server URL to access OpenVSCode Server.

![image showing where the URL can be found](https://user-images.githubusercontent.com/36797588/134728867-54de3d3f-31e5-4c08-a239-f6d2babeec7b.png)

## Teardown

Delete the service in your dashboard.

---

# Deploy Secure OpenVSCode Server to Render with OAuth

## Prerequisites

To complete this guide, you need:

- a [Render](https://render.com/) account
- an account with the [OAuth Provider](https://oauth2-proxy.github.io/oauth2-proxy/docs/configuration/oauth_provider) of your choice.

## Set up OAuth application with provider

Consult the [OAuth2-Proxy Provider Configuration Documentation](https://oauth2-proxy.github.io/oauth2-proxy/docs/configuration/oauth_provider/), and select at least one provider to use for authenticating users of Open VSCode. Create an OAuth application with your provider of choice. For the Homepage/Base URI, enter a placeholder like `https://openvscode-secure-server.onrender.com`, and for the Callback/Redirect URI, enter a placeholder like `https://openvscode-secure-server.onrender.com/oauth2/callback`. You will update the OAuth2 app with your URIs once your OAuth2-Proxy Server deployment is complete. Save the Client Secret and ID in a secure place like a password manager for later reference.

## Set up Open VSCode and OAuth Servers

To deploy Open VSCode to Render as a private service that's publicly accessible with authentication, click the following button and follow the instructions:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/openvscode-with-oauth)

You will create a name for the service group (for example `Secure OpenVSCode Server`). After that, enter the environment variable values to configure your OAuth provider:

- For `OAUTH2_PROXY_CLIENT_ID` enter the Client ID from your OAuth App
- For `OAUTH2_PROXY_CLIENT_SECRET` enter the Client Secret from your OAuth App or password manager
- For `OAUTH2_PROXY_PROVIDER` enter the name of your OAuth provider

Click <kbd>Apply</kbd> to create the services.

## Start the server

Render starts both servers automatically in sequence. Monitor progress from the service creation page:
![Image showing where to access the authentication server](https://user-images.githubusercontent.com/36797588/135170007-814862c9-7d93-42ed-9112-74427066300c.jpeg)

When the deployment is complete, click the link to your `oauth2-proxy` web service.

## Locate your OAuth server address

In the dashboard entry for your `oauth2-proxy` web service, locate and copy your authentication server URL:
![Image showing where to find the authentication server URL](https://user-images.githubusercontent.com/36797588/135170659-c84ed169-72c1-4ed3-a8c7-c685b547bba3.jpeg)

## Update OAuth application with provider

Return to the OAuth application that you set up in an earlier step. Update the homepage/base URI and the callback/redirect URI using the address copied from the `oauth2-proxy` web service and save your changes.

![Image showing which URL fields to update in the Google OAuth Application](https://user-images.githubusercontent.com/36797588/135171263-47f78f3b-2a34-4ae7-a718-5f69250edc8b.jpeg)

## Access OpenVSCode Server

In the dashboard entry for your `oauth2-proxy` web service, click the server URL to access OpenVSCode Server. You will be prompted to authenticate and then redirected to the private Open VSCode service.
![Image showing the authentication screen](https://user-images.githubusercontent.com/36797588/135171787-0434bf26-838c-47a0-9990-0af66a9651f3.jpeg)

## Teardown

Delete the services in your dashboard.
