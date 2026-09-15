package model

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/zxh326/kite/pkg/utils"
)

type SecretString string

// Scan implements the sql.Scanner interface for reading encrypted data from database
func (s *SecretString) Scan(value interface{}) error {
	if value == nil {
		*s = ""
		return nil
	}
	var encryptedStr string
	switch v := value.(type) {
	case string:
		encryptedStr = v
	case []byte:
		encryptedStr = string(v)
	default:
		return fmt.Errorf("cannot scan %T into SecretString", value)
	}
	// If the string is empty, just set it directly
	if encryptedStr == "" {
		*s = ""
		return nil
	}

	// Decrypt the string
	decrypted, err := utils.DecryptString(encryptedStr)
	if err != nil {
		return fmt.Errorf("failed to decrypt SecretString: %w", err)
	}
	*s = SecretString(decrypted)
	return nil
}

// Value implements the driver.Valuer interface for writing encrypted data to database
func (s SecretString) Value() (driver.Value, error) {
	if s == "" {
		return "", nil
	}
	utils.WarnOnDefaultEncryptKey()
	encrypted, err := utils.EncryptString(string(s))
	if err != nil {
		return nil, fmt.Errorf("encryption failed: %w", err)
	}
	return encrypted, nil
}

type LowerCaseString string

func (s *LowerCaseString) Scan(value interface{}) error {
	if value == nil {
		*s = ""
		return nil
	}
	var str string
	switch v := value.(type) {
	case string:
		str = v
	case []byte:
		str = string(v)
	default:
		return fmt.Errorf("cannot scan %T into LowerCaseString", value)
	}
	*s = LowerCaseString(strings.ToLower(str))
	return nil
}

func (s LowerCaseString) Value() (driver.Value, error) {
	return strings.ToLower(string(s)), nil
}

type SliceString []string

func (s *SliceString) Scan(value interface{}) error {
	if value == nil {
		*s = nil
		return nil
	}
	var strArray []string
	switch v := value.(type) {
	case string:
		strArray = strings.Split(v, ",")
	case []byte:
		strArray = strings.Split(string(v), ",")
	default:
		return fmt.Errorf("cannot scan %T into SliceString", value)
	}
	// 历史数据可能存有 "a," / ",a" / "" 这类值，Split 会产生空字符串元素；
	// 它们会被前端当成一个"空名组"，进而触发对 /admin/groups/ 的非法请求。
	// 这里在读取侧统一清洗：去空白、丢弃空元素。
	cleaned := make(SliceString, 0, len(strArray))
	for _, item := range strArray {
		if item = strings.TrimSpace(item); item != "" {
			cleaned = append(cleaned, item)
		}
	}
	*s = cleaned
	return nil
}

func (s SliceString) Value() (driver.Value, error) {
	if s == nil {
		return "", nil
	}
	cleaned := make(SliceString, 0, len(s))
	for _, item := range s {
		if item = strings.TrimSpace(item); item != "" {
			cleaned = append(cleaned, item)
		}
	}
	if len(cleaned) == 0 {
		return "", nil
	}
	return strings.Join(cleaned, ","), nil
}

// JSONField stores arbitrary JSON data
type JSONField []byte

func (j *JSONField) Scan(value interface{}) error {
	if value == nil {
		*j = nil
		return nil
	}
	switch v := value.(type) {
	case string:
		*j = []byte(v)
	case []byte:
		*j = v
	default:
		return fmt.Errorf("cannot scan %T into JSONField", value)
	}
	return nil
}

func (j JSONField) Value() (driver.Value, error) {
	if j == nil {
		return nil, nil
	}
	return string(j), nil
}

// Unmarshal deserializes the JSON data into the provided interface
func (j JSONField) Unmarshal(v interface{}) error {
	if j == nil {
		return nil
	}
	return json.Unmarshal(j, v)
}

// Marshal serializes the provided interface into JSON
func (j *JSONField) Marshal(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	*j = data
	return nil
}
