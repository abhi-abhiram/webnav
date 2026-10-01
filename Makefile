.PHONY: setup fmt fmt-check vet test race dom-test check build smoke clean
setup:
	go mod download
fmt:
	gofmt -w cmd internal scripts
fmt-check:
	test -z "$$(gofmt -l $$(find cmd internal scripts -name '*.go'))"
vet:
	go vet ./...
test:
	go test ./...
race:
	go test -race ./...
dom-test:
	node internal/browser/helpers/observe.test.cjs
check: fmt-check vet race dom-test
build:
	mkdir -p bin
	go build -trimpath -o bin/discord-mcp ./cmd/discord-mcp
smoke: build
	go run ./scripts/smoke ./bin/discord-mcp
clean:
	rm -rf bin coverage.out
