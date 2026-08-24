# Netskope development certificate authority

The audit image verifies TLS certificates by default and includes the public
Netskope root CA used by this team's HTTPS inspection environment. The public
certificate at `certs/development-ca.crt` is baked into the image so Chromium,
WebKit, Firefox, Node, curl, and Lighthouse can keep certificate verification
enabled during normal Docker runs.

Chromium's independent root verifier is additionally scoped to the SHA-256
SPKI of this exact public root through the shared `audit/tls.ts` policy used by
both Playwright and Lighthouse. This is a pinned
corporate trust exception, not the unrestricted development certificate
bypass exposed by the portal. Playwright's Firefox build uses an isolated,
temporary NSS profile, so its container-only executable wrapper imports this
exact CA into that profile before Firefox starts. WebKit and command-line
clients use the updated Linux trust store.

Compose also bind-mounts this directory read-only so container startup can
install the selected public CA into the Linux and Firefox trust stores without
changing run artifacts. When replacing the CA, also update its pinned Chromium
SPKI in `audit/tls.ts` and rebuild the image. Startup logs identify the active
trust path.

Never place a private key in this directory. The required file is a public CA
certificate in PEM format only.
