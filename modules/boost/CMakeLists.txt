include(FetchContent)

set(BOOST_INCLUDE_LIBRARIES asio;beast;system)

FetchContent_Declare(
        Boost
        GIT_REPOSITORY https://github.com/boostorg/boost.git
        GIT_TAG boost-1.92.0
)

FetchContent_MakeAvailable(Boost)

add_library(boost_wrapper)

target_sources(
        boost_wrapper
        PUBLIC
        FILE_SET CXX_MODULES
        FILES
        ${CMAKE_CURRENT_SOURCE_DIR}/boost_wrapper.cppm
)

target_link_libraries(
        boost_wrapper
        PUBLIC
        Boost::asio
        Boost::beast
        Boost::system
)
