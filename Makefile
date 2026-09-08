.PHONY: up down reset dev seed test typecheck mobile ci

up:            ## start postgres + minio
	docker compose up -d
	@echo "waiting for postgres..."
	@until docker compose exec -T postgres pg_isready -U flyleaf -d flyleaf >/dev/null 2>&1; do sleep 1; done
	@echo ready

down:
	docker compose down

reset:         ## destroy the volume and re-run the schema
	docker compose down -v
	$(MAKE) up

dev:
	cd apps/api && npm run dev

seed:          ## load the 102-book CSV
	cd apps/api && npm run seed -- ../../db/skeleton/books.csv

test:
	cd apps/api && npm test

smoke:         ## walk the whole API path and assert the locked decisions
	pwsh -File scripts/smoke.ps1

typecheck:
	cd apps/api && npm run typecheck
	cd apps/mobile && npm run typecheck

ci:            ## everything GitHub Actions runs, before you push
	node scripts/ci.mjs

mobile:
	cd apps/mobile && npx expo start
