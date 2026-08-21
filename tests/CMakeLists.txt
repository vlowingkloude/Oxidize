add_executable(oxidize_tests main.cpp)

target_link_libraries(
        oxidize_tests
        PRIVATE
        files
        lsp
)

add_test(NAME oxidize_tests COMMAND oxidize_tests)
set_tests_properties(oxidize_tests PROPERTIES TIMEOUT 30)
