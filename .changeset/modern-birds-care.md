---
"@medusajs/core-flows": patch
---

fix(core-workflows): Fix data returned from reset password event.

Deprecate `actorType` in favor of `actor_type`. The field `actorType` will be removed in a future version, so please update your code to use `actor_type` instead.
