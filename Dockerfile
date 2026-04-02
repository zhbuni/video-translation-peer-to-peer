FROM golang:1.24-alpine AS build

WORKDIR /src

COPY go.mod go.sum ./

RUN go mod download

COPY cmd/ cmd/
COPY internal/ internal/

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/signaling-server ./cmd/signaling-server


FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=build /out/signaling-server /app/signaling-server

ENV PORT=8080
EXPOSE 8080

USER nonroot:nonroot
ENTRYPOINT ["/app/signaling-server"]

