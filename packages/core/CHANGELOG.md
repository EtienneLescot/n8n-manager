# Changelog

## [0.7.0](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.6.2...@n8n-as-code/n8n-manager-core-v0.7.0) (2026-05-06)


### Features

* **core:** add ability to refresh public auth bridge tunnel ([9e1f456](https://github.com/EtienneLescot/n8n-manager/commit/9e1f456248e297f428cf5fa18dc125f9e7226a55))

## [0.6.2](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.6.1...@n8n-as-code/n8n-manager-core-v0.6.2) (2026-05-06)


### Bug Fixes

* make public tunnel launches resilient on Windows ([58fa6e4](https://github.com/EtienneLescot/n8n-manager/commit/58fa6e49171a5b8c841a7fbe7a09f0f24285e193))

## [0.6.1](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.6.0...@n8n-as-code/n8n-manager-core-v0.6.1) (2026-05-05)


### Bug Fixes

* **core:** document detached shell syntax constraint ([94a2162](https://github.com/EtienneLescot/n8n-manager/commit/94a2162a1942568ce5745eced56ffdf931e84db4))

## [0.6.0](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.5.2...@n8n-as-code/n8n-manager-core-v0.6.0) (2026-05-04)


### Features

* **core:** implement file locking and detached process utilities ([bea4c88](https://github.com/EtienneLescot/n8n-manager/commit/bea4c884f0093c7b072b4f927219f7abda95fd10))


### Bug Fixes

* **prerelease:** trigger prerelease ([97f1bed](https://github.com/EtienneLescot/n8n-manager/commit/97f1bed667394f487e7e036733b362989f5e53e8))

## [0.5.2](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.5.1...@n8n-as-code/n8n-manager-core-v0.5.2) (2026-05-02)


### Bug Fixes

* **release:** trigger release PR ([e615db9](https://github.com/EtienneLescot/n8n-manager/commit/e615db9321af0031f4842b181607f1516c880558))

## [0.5.1](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.5.0...@n8n-as-code/n8n-manager-core-v0.5.1) (2026-05-02)


### Bug Fixes

* **core:** refresh stale auth bridge URLs and improve log isolation ([0e075af](https://github.com/EtienneLescot/n8n-manager/commit/0e075af21136e20c2f6417b6e4f6e1c0e39762fa))

## [0.5.0](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.4.1...@n8n-as-code/n8n-manager-core-v0.5.0) (2026-04-30)


### Features

* **core:** improve local bridge process spawning and test reliability ([b364e66](https://github.com/EtienneLescot/n8n-manager/commit/b364e66e05b070b678c1d47be869d35c5a1abe0d))

## [0.4.1](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.4.0...@n8n-as-code/n8n-manager-core-v0.4.1) (2026-04-30)


### Bug Fixes

* **core:** handle Docker port conflicts by falling back to available ports ([0dc894e](https://github.com/EtienneLescot/n8n-manager/commit/0dc894ede2e6ecd5c9b33b4c5780406f11de26c3))

## [0.4.0](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.3.0...@n8n-as-code/n8n-manager-core-v0.4.0) (2026-04-30)


### Features

* **cli:** add instance access commands and improve tunnel error handling ([9e91298](https://github.com/EtienneLescot/n8n-manager/commit/9e91298b2c69de01c243602ee8f018c5d4e1224d))

## [0.3.0](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.2.0...@n8n-as-code/n8n-manager-core-v0.3.0) (2026-04-30)


### Features

* **core:** enhance n8n instance management and tunnel error reporting ([fcbb3ab](https://github.com/EtienneLescot/n8n-manager/commit/fcbb3ab3c717bbd3bab8006440e7f69b3810eb20))
* **core:** expose auth bridge open URL and warning reporting ([ace5857](https://github.com/EtienneLescot/n8n-manager/commit/ace58571100e823c14a85668bd8b74db24d77519))


### Bug Fixes

* add repository metadata for trusted publishing ([18ea97d](https://github.com/EtienneLescot/n8n-manager/commit/18ea97d53bce9a50655d4a778d1121f7bb63c0d2))

## [0.2.0](https://github.com/EtienneLescot/n8n-manager/compare/@n8n-as-code/n8n-manager-core-v0.1.0...@n8n-as-code/n8n-manager-core-v0.2.0) (2026-04-30)


### Features

* add runtime orchestration commands ([c3e5785](https://github.com/EtienneLescot/n8n-manager/commit/c3e5785cb9459505b7efe154fe8f46e0aa7a4745))
* centralize n8n instance configuration ([6089725](https://github.com/EtienneLescot/n8n-manager/commit/60897259b99b68fb6ee7982f7ec073876b5b21ec))


### Bug Fixes

* pair auth bridge tunnel with n8n tunnel ([f5c98ef](https://github.com/EtienneLescot/n8n-manager/commit/f5c98ef69ba4afaa2aeacb25795c5bbcaf35ff7b))
* resolve workflow presentation from workspace context ([bc8774b](https://github.com/EtienneLescot/n8n-manager/commit/bc8774bad6b3f5f93351bd5a9676412ed1e28354))
* retrigger package release workflow ([7790633](https://github.com/EtienneLescot/n8n-manager/commit/7790633e788105aa9d5b86f2c91327f1de83a929))
* test package release workflow ([288b463](https://github.com/EtienneLescot/n8n-manager/commit/288b463352c7d0b577c76fe494baa42de4f7b524))
* test release please ([1474bc0](https://github.com/EtienneLescot/n8n-manager/commit/1474bc03cf6c9fee68631da23932aa59961c2e76))
