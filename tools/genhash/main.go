package main

import (
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

func main() {
	h, _ := bcrypt.GenerateFromPassword([]byte("Test1234!abcd"), 12)
	fmt.Println(string(h))
}
