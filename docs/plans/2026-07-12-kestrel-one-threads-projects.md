---
id: kestrel-one-threads-projects
domain: product
status: implemented
owner: kestrel-one
last_verified_at: 2026-07-12
depends_on:
  - ARCHITECTURE.md
  - SECURITY.md
  - apps/kestrel-one/README.md
---

# Kestrel One Threads and Projects

Kestrel One is organized around durable Threads and hosted-product Projects. Every legacy Chat becomes a Thread with the same primary key, runner session, transcript, artifacts, media references, and share state. A Thread is standalone or belongs to one Project. Hosted Projects do not alias runtime threads, source workspaces, or Mission Control projects.

A Project is an explicit collaboration and context boundary. Current owners, editors, and members can read and continue all Project Threads. Owners manage membership and lifecycle; owners and editors manage Project instructions, private files, selected organization Knowledge, and public Thread sharing. Context updates are immutable revisions, and every new turn records both human authorship and the revision used. Deferred database constraints enforce at least one owner at transaction commit, including for direct writes and cascading membership changes.

Authorization is applied before Project, Thread, message, file, stream, artifact, retrieval, and search data is returned. Runtime retrieval uses a short-lived opaque grant bound to one organization, Project, Thread, actor, and immutable context revision; the grant is revalidated on every use and revoked when the turn finishes. Search is grouped into Projects, Threads, and Messages; each group uses Postgres `simple` full text, `ts_rank_cd` descending, updated time descending, and stable ID ordering without cross-type scoring or fallback heuristics.

The product surface is a controlled hard cutover to `/threads`, `/projects`, `/search`, and their canonical APIs. The workspace uses a global application rail plus a contextual Project/Thread rail, Project Home, archive-first lifecycle controls, explicit disclosure when a standalone Thread becomes shared through a Project, and anonymized public transcripts.
