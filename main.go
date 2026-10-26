package main

import (
	"context"
	"embed"
	"io/fs"
	"log"
	"runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:site
var siteFiles embed.FS

func main() {
	site, err := fs.Sub(siteFiles, "site")
	if err != nil {
		log.Fatal(err)
	}
	app := &App{}
	var appMenu *menu.Menu
	if runtime.GOOS == "darwin" {
		appMenu = menu.NewMenuFromItems(menu.AppMenu(), menu.EditMenu())
	}
	err = wails.Run(&options.App{
		Title:            "pzcleaner",
		Width:            1400,
		Height:           900,
		MinWidth:         960,
		MinHeight:        640,
		BackgroundColour: &options.RGBA{R: 10, G: 20, B: 30, A: 255},
		AssetServer:      &assetserver.Options{Assets: site},
		Menu:             appMenu,
		OnStartup:        func(ctx context.Context) { app.ctx = ctx },
		OnShutdown:       func(_ context.Context) { app.Disconnect() },
		Bind:             []interface{}{app},
	})
	if err != nil {
		log.Fatal(err)
	}
}
