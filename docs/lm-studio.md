# LM Studio connections

Roo connects from the extension host. In code-server or Remote SSH, localhost
means the remote server or container, not the browser's computer.

## Dedicated LM Studio provider

Select **LM Studio**, enter the server URL, and choose a chat model. The source
changes in 4.2.34 add an **API token (optional)** field:

- Leave it blank when the server does not require authentication. Discovery and
  inference omit the Authorization header.
- Enter the server-issued token when authentication is enabled. It is stored as
  a provider secret and sent as a Bearer token. Invalid credentials do not cause
  an automatic unauthenticated retry.
- Use the server root, for example **http://127.0.0.1:1234**. The updated provider
  also accepts a trailing **/v1** and removes duplicate version prefixes.
- Model discovery uses the current draft URL/token. It refreshes after changes
  and has a **Refresh models** button. Empty lists and errors are displayed;
  delayed results from an earlier configuration are ignored.

The native REST model catalog includes downloaded chat models and loaded
instances. Loaded inference identifiers and runtime context sizes take priority.
Embedding models are excluded from the chat picker. Listing models does not load
them or change server settings. Load your selected model in LM Studio or enable
the server's own just-in-time loading. Roo no longer explicitly loads a model
while refreshing its metadata.

Older servers or REST-only proxies fall back to the OpenAI-compatible model list.
Unauthenticated servers can also supply SDK metadata. The bundled SDK does not
support API tokens, so authenticated discovery uses REST only. If an older
authenticated endpoint exposes only untyped model identifiers, downloaded-model
visibility, embedding classification, and runtime context metadata may be limited.
The picker can list only models exposed to that endpoint and token.

Model metadata is memory-only and separated by server and credential identity;
LM Studio does not reuse the provider-wide disk catalog. Discovery waits are
bounded. The legacy SDK cannot cancel/dispose an outstanding operation, so its
transport may outlive the caller timeout.

## OpenAI Compatible alternative

This route uses the server URL ending in **/v1**, streaming, and the exact chat
model identifier. In 4.2.33 it still requires a non-empty API key in Roo's UI,
even for an unauthenticated server. A dummy value such as **lm-studio** works
when the server ignores authentication; it provides no access protection.
Use a real server-issued token when required.

The OpenAI-compatible route was live-tested on the reported server with one
small text-streaming request and one synthetic tool-call request. Both succeeded;
no tool executed and no workspace or conversation data was transmitted. Native
REST and unauthenticated SDK discovery also succeeded. The server exposed one
chat model and one embedding model. Its loaded chat context was 126,720 tokens,
not the model's maximum 262,144. Authenticated behavior is covered by mocked
transport tests, not a live authenticated server.

## Security and deployment

Use a private network, SSH tunnel, or authenticated HTTPS for remote access.
Public unauthenticated HTTP exposes prompts and access to inference resources.
Never put tokens in the URL. Discovery errors are sanitized; inference errors
preserve HTTP status without logging response bodies that may contain secrets.

These dedicated-provider improvements require 4.2.34 or later;
they are not included in 4.2.33. Full Roo task behavior, all model architectures,
and speculative decoding have not been live-validated by the small probes.
