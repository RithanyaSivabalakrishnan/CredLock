CC      = gcc
CFLAGS  = -std=c11 -Wall -Wextra -O2 -I.
SRC_DIR = src/wasm
SRCS    = $(SRC_DIR)/crypto_engine.c $(SRC_DIR)/key_derivation.c
TEST_SRC= tests/test_crypto.c

test-c: build/test_crypto
	@echo ""
	@./build/test_crypto
	@echo ""

build/test_crypto: $(TEST_SRC) $(SRCS) $(SRC_DIR)/crypto_types.h
	@mkdir -p build
	$(CC) $(CFLAGS) $(TEST_SRC) $(SRCS) -o build/test_crypto

EMCC    = emcc
EMFLAGS = \
	-s EXPORTED_FUNCTIONS='["_sv_encrypt","_sv_decrypt","_sv_derive_key","_sv_hkdf","_sv_hash","_sv_zeroize","_sv_alloc","_sv_free","_malloc","_free"]' \
	-s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8"]' \
	-s MODULARIZE=1 -s EXPORT_NAME="VaultCrypto" \
	-s ALLOW_MEMORY_GROWTH=1 \
	-O2 --no-entry

wasm: $(SRCS) $(SRC_DIR)/crypto_types.h
	$(EMCC) $(SRCS) -o src/wasm/crypto_engine.wasm $(EMFLAGS)
	@echo "Built: src/wasm/crypto_engine.wasm"

clean:
	rm -rf build src/wasm/crypto_engine.wasm

.PHONY: test-c wasm clean
