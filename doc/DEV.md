## Observability

### Metrics defintion
- Declare new metrics or update existing in https://github.com/gitpod-io/gitpod/blob/ad355c4d9abd858a44daf15f9bd6747976142911/install/installer/pkg/components/ide-metrics/configmap.go
- Create a new branch and push, wait for https://werft.gitpod-dev.com/ to create a preview env.

### Collecting metrics
- Convert VS Code telemetry to metrics in https://github.com/gitpod-io/openvscode-server/blob/63796b8c6eca9bcaf36b90ae1e96dae32638bab6/src/vs/gitpod/common/insightsHelper.ts#L35.

### Testing from sources
- Add to product.json (don't commit!):
```jsonc
"gitpodPreview": {
	"host": "<host of preview env>",
	// optionally to log to stdout or browser console
	"log": {
		"metrics": true,
		"analytics": false,
	}
}
```
- Restart VS Code Server and open VS Code preview page to trigger telemetry events.
- In dev workspace for gitpod-io/gitpod run `./dev/preview/portforward-monitoring-satellite.sh -c harvester`
- Navigate to a printed Grafana link, open Explorer view, select prometheus as a data source and query for metrics.

### Integration testing

- Commit changes in this repo.
- Update codeCommit in WORKSPACE.yaml in gitpod-io/gitpod and push.
- Wait for https://werft.gitpod-dev.com/ to update preview envs.
- Test the complete integration.
