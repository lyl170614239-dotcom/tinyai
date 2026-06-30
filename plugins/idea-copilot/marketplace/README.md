# Marketplace Publishing

JetBrains IDEA users can find this plugin in `Settings | Plugins | Marketplace`
only after it is published to JetBrains Marketplace, or after their IDE is
configured with an internal custom plugin repository.

## Public JetBrains Marketplace

1. Create the plugin entry in JetBrains Marketplace once manually.
2. Generate a Marketplace upload token.
3. Build and publish:

```bash
cd plugins/idea-copilot
./gradlew publishPlugin \
  -PlocalIdePath="/Applications/IntelliJ IDEA.app" \
  -PintellijPlatformPublishingToken="$JETBRAINS_MARKETPLACE_TOKEN" \
  -PpluginReleaseHidden=true
```

`pluginReleaseHidden=true` keeps the uploaded version hidden until it is
reviewed and intentionally released.

## Internal Custom Plugin Repository

For a company-only rollout, host `updatePlugins.xml` and the plugin ZIP on an
internal HTTPS server. Then add that repository URL in IDEA:

```text
Settings | Plugins | gear icon | Manage Plugin Repositories...
```

Use `updatePlugins.example.xml` as the repository descriptor template.
