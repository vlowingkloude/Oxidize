module;

#include <nlohmann/json.hpp>

export module json;

export namespace oxidize::json {
    using json_type = nlohmann::json;
}