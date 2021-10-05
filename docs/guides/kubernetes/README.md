# Deploy OpenVSCode Server to Kubernetes

## Prerequisites

To complete this guide, you need:
- a Kubernetes 1.19+ cluster
- the [kubectl CLI](https://kubernetes.io/docs/reference/kubectl/overview/)
- the [ytt CLI](https://carvel.dev/ytt/) (YAML templating tool from the [Carvel tools](https://carvel.dev/))

## Setup

The directories `config` and `config-ext` contain Kubernetes manifest files,
using ytt for templating.

Check out file `config/values.yml` to see overridable parameters:

```yaml
#@data/values
---
#! Set application name.
APP: openvscode-server

#! Set target namespace.
NAMESPACE: openvscode

#! Set the public-facing domain used for accessing the application.
DOMAIN: openvscode.example.com

#! Set storage class to use for persistent data.
STORAGE_CLASS: ""

#! Set storage size for persistent data.
STORAGE_SIZE: 2Gi

#! Set storage mode for persistent data.
STORAGE_ACCESS_MODE: ReadWriteOnce

#! Set cert-manager cluster issuer to use when ingress TLS is enabled.
CERT_MANAGER_CLUSTER_ISSUER: letsencrypt-prod
```

In order to override any of these parameters, create a new file.
For example, let's create file `config-env/my-values.yml`:

```yaml
#@data/values
---
#! Set a custom value for parameter domain.
DOMAIN: vscode.company.com
```

In `config-ext` you'll find configuration overlays, providing extensions
for the base configuration.

For example, let's say you want to expose OpenVSCode Server using an
`Ingress` route (`ClusterIP` is used by default, preventing any external access),
you may want to add the overlay `config-ext/ingress.yml`.

In case you're using [Contour](https://projectcontour.io/)
as an `Ingress` controller, you need to enable WebSocket support by adding the overlay
`config-ext/ingress-contour.yml`.

In order to enable TLS configuration at the `Ingress` level, just add the
overlay `config-ext/ingress-tls.yml`: please note that you need
[cert-manager](https://cert-manager.io/) up and running in order to
generate TLS certificates.

Now that you have your customized parameters ready, let's use ytt to generate
the target Kubernetes manifest files:

```shell
ytt -f config -f config-ext/ingress.yml -f config-ext/ingress-contour.yml -f config-env/my-values.yml
```

## Start the server

You're almost done!

Deploy OpenVSCode Server to your Kubernetes cluster using kubectl and ytt:

```shell
ytt -f config -f config-ext/ingress.yml -f config-ext/ingress-contour.yml -f config-env/my-values.yml | kubectl apply -f-
```

OpenVSCode Server is running in the namespace `openvscode` by default:

```shell
kubectl -n openvscode get po
NAME                      READY   STATUS    RESTARTS   AGE
server-56c675fb56-c8jz6   1/1     Running   0          53s
```

## Access OpenVSCode Server

The default configuration does not expose OpenVSCode Server: you need to
open a connection to the Kubernetes service from your workstation:

```shell
kubectl -n openvscode port-forward svc/server 3000:3000
```

Now open your browser at localhost:3000 and start using OpenVSCode Server.

In case you enabled overlays for `Ingress` support, just open your browser
with the domain you've set in the configuration parameters (see `DOMAIN`):

```shell
kubectl -n openvscode get ingress
```

## Teardown

Remove OpenVSCode Server from your cluster by deleting its namespace
(default is `openvscode`):

```shell
kubectl delete ns openvscode
```
