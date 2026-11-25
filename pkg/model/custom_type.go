package model

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"strings"

	"aerolink/pkg/utils"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

type SecretString string

// Scan 实现 sql.Scanner 接口，用于从数据库读取加密数据
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
	// 字符串为空时直接赋值
	if encryptedStr == "" {
		*s = ""
		return nil
	}

	// 解密该字符串
	decrypted, err := utils.DecryptString(encryptedStr)
	if err != nil {
		return fmt.Errorf("failed to decrypt SecretString: %w", err)
	}
	*s = SecretString(decrypted)
	return nil
}

// Value 实现 driver.Valuer 接口，用于把加密数据写入数据库
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

// JSONField 存储任意 JSON 数据
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

// Unmarshal 把 JSON 数据反序列化到给定的 interface
func (j JSONField) Unmarshal(v interface{}) error {
	if j == nil {
		return nil
	}
	return json.Unmarshal(j, v)
}

// Marshal 把给定的 interface 序列化为 JSON
func (j *JSONField) Marshal(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	*j = data
	return nil
}

// GormDBDataType 让 JSONField 在 MySQL 上落成 LONGTEXT：列里存的是任意 JSON
// （AI 会话历史、工具结果里的整份资源清单），不该受 MySQL TEXT 的 64 KiB 限制。
func (JSONField) GormDBDataType(db *gorm.DB, _ *schema.Field) string {
	return unlimitedTextType(db)
}

// LongText 用于可能超过 MySQL TEXT 上限的字符串列（资源清单、AI 上下文）。
type LongText string

func (LongText) GormDBDataType(db *gorm.DB, _ *schema.Field) string {
	return unlimitedTextType(db)
}

// unlimitedTextType 返回不限长度的文本列类型。MySQL 的 TEXT 上限是 64 KiB，超长内容
// 写入直接报 1406；PostgreSQL / SQLite 的 text 本身没有这个上限，而把 MySQL 专有的
// LONGTEXT 写死进标签又会让 PostgreSQL 建表失败，所以按方言给出。
func unlimitedTextType(db *gorm.DB) string {
	if db != nil && db.Dialector != nil && db.Name() == "mysql" {
		return "longtext"
	}
	return "text"
}
