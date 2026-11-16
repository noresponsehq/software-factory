package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	fs := token.NewFileSet()
	files, err := filepath.Glob(filepath.Join(os.Args[1], "*.go"))
	if err != nil {
		panic(err)
	}
	defs := map[string]ast.Node{}
	imports := map[string]string{}
	var controls []ast.Node
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		tree, err := parser.ParseFile(fs, file, nil, 0)
		if err != nil {
			panic(err)
		}
		for _, spec := range tree.Imports {
			path, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				panic(err)
			}
			alias := filepath.Base(path)
			if spec.Name != nil {
				alias = spec.Name.Name
			}
			if previous, ok := imports[alias]; ok && previous != path {
				panic("ambiguous control import")
			}
			imports[alias] = path
		}
		for _, decl := range tree.Decls {
			switch d := decl.(type) {
			case *ast.GenDecl:
				for _, spec := range d.Specs {
					if v, ok := spec.(*ast.ValueSpec); ok {
						for _, n := range v.Names {
							defs[n.Name] = v
						}
					}
				}
			case *ast.FuncDecl:
				if d.Recv == nil {
					defs[d.Name.Name] = d
				}
			}
		}
		ast.Inspect(tree, func(node ast.Node) bool {
			literal, ok := node.(*ast.CompositeLit)
			if !ok {
				return true
			}
			typ, ok := literal.Type.(*ast.SelectorExpr)
			if !ok || typ.Sel.Name != "Known" {
				return true
			}
			name, ok := typ.X.(*ast.Ident)
			if !ok || imports[name.Name] != "github.com/noresponsehq/noresponse/apps/identity/internal/connector" {
				panic("untrusted Known alias")
			}
			controls = append(controls, literal)
			return true
		})
	}
	if len(controls) == 0 {
		panic("no statically pinned control declaration")
	}
	rendered := map[string]string{}
	var visit func(ast.Node)
	visit = func(node ast.Node) {
		var buf bytes.Buffer
		if err := format.Node(&buf, fs, node); err != nil {
			panic(err)
		}
		key := buf.String()
		if _, exists := rendered[key]; exists {
			return
		}
		rendered[key] = key
		ast.Inspect(node, func(n ast.Node) bool {
			ident, ok := n.(*ast.Ident)
			if !ok {
				return true
			}
			if def, ok := defs[ident.Name]; ok {
				visit(def)
			}
			if path, ok := imports[ident.Name]; ok {
				rendered["import:"+ident.Name] = path
			}
			return true
		})
	}
	for _, control := range controls {
		visit(control)
	}
	keys := make([]string, 0, len(rendered))
	for key := range rendered {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	output := make([]string, 0, len(keys))
	for _, key := range keys {
		output = append(output, key+"="+rendered[key])
	}
	if err := json.NewEncoder(os.Stdout).Encode(output); err != nil {
		panic(err)
	}
}
