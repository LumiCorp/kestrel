# Hosted Browser runtime staging

The hosted Browser image build expects these two exact release inputs here:

- `agent-browser-linux-x64`
- `chrome-linux64.zip`

Do not download or commit them by hand. The Product Brief requires signed release
evidence in addition to the checked-in SHA-256 values. Kestrel does not yet have
a trusted hosted Browser release key or an approved signature receipt format, so
the production staging and publication step remains fail-closed. The Docker build
also verifies both pinned SHA-256 values before copying either executable into the
runtime image.
