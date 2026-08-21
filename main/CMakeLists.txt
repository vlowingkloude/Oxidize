add_executable(oxidize main.cpp)

target_compile_definitions(
        oxidize
        PRIVATE
        OXIDIZE_DEFAULT_STATIC_DIRECTORY="${OXIDIZE_FRONTEND_DIST_DIRECTORY}"
)

target_link_libraries(
        oxidize
        PRIVATE
        files
        server
)
