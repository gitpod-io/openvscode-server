package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

func newReverseProxy(target string) *httputil.ReverseProxy {
	url, _ := url.Parse(target)
	return httputil.NewSingleHostReverseProxy(url)
}

func handler(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/_supervisor") {
		proxy := newReverseProxy("http://localhost:22999")
		proxy.ServeHTTP(w, r)
	} else {
		proxy := newReverseProxy("http://localhost:9888")
		proxy.ServeHTTP(w, r)
	}
}

func main() {
	http.HandleFunc("/", handler)
	log.Println("Starting proxy server on :8080")
	err := http.ListenAndServe(":8080", nil)
	if err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
