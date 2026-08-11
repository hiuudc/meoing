# Vendored Lexical Playground

This directory is a vendored snapshot of Lexical Playground source from:

https://github.com/facebook/lexical/tree/2929ef39ecf479db5ee3f4473d3ba9c9086bc9f4/packages/lexical-playground

Upstream commit: `2929ef39ecf479db5ee3f4473d3ba9c9086bc9f4`

The upstream source is licensed under the MIT License. Copyright notices in
the vendored files are preserved. Meoing imports only the adapter-selected
plugins; collaboration, comments, test recorder, and debug tooling remain
unmounted because this application does not provide their services.

The Meoing adapter supplies the existing document JSON, safe image/link
handling, custom nodes, persistence, and the application theme. Vendored
toolbar and component-picker option lists are intentionally pruned only where
they would expose unsupported services or nodes not registered by Meoing;
their core interaction code remains upstream.
